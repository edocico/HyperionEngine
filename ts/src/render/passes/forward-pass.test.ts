import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ForwardPass } from './forward-pass';
import { BUCKETS_PER_TYPE, OPAQUE_DRAW_BUCKETS } from './cull-pass';
import { primitiveGroup0LayoutEntries, textureTierLayoutEntries } from '../primitive-bindings';
import { ResourcePool } from '../resource-pool';
import type { FrameState } from '../render-pass';
import { SCENE_HDR_FORMAT } from '../formats';
import {
  PRIMITIVE_LIBRARIES, composeTypeModules, composeUberModule,
  type PrimitiveLibrary, type PrimitiveLibraryName,
} from '../primitive-shaders';
import { loadPrimitivePieces } from '../primitive-pieces.fixture';
import { bindingDecls, callGraph, functionBody, reachableFrom, stripComments } from '../../shaders/wgsl-analysis';
import { structSize } from '../../shaders/uniform-layout';

// The WebGPU enums the fake devices and the shared layouts read (node has no WebGPU).
const g = globalThis as Record<string, unknown>;
g.GPUBufferUsage ??= { COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100 };
g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
g.GPUTextureUsage ??= { COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };

/** Stand-in for the uber module: the fake devices compile nothing, they record. */
const UBER_STUB = 'uber stub';

/**
 * The fixture every setup() in this file shares: a pool holding what
 * ForwardPass.setup reads (its buffers, the tier views and scene-hdr, the
 * sampler), and `pass` set up on `device` over it with `sources` as
 * SHADER_SOURCES and `uber` as UBER_SOURCE. SHADER_SOURCES is filled in place,
 * as the renderer does (LightGroupsPass and the probes hold the object); both
 * statics are restored afterwards, also when setup() throws. Each pool buffer
 * is a distinct object carrying its name (`pool.getBuffer(name)` gives it
 * back, for identity checks); `omit` leaves the named ones out of the pool.
 */
function setUpOnPool(
  pass: ForwardPass, device: GPUDevice, sources: Record<number, string>, uber = UBER_STUB,
  { omit = [] }: { omit?: string[] } = {},
): ResourcePool {
  const pool = new ResourcePool();
  for (const name of ['entity-transforms', 'visible-indices', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params', 'transparent-order', 'transparent-args']) {
    if (!omit.includes(name)) pool.setBuffer(name, { name } as unknown as GPUBuffer);
  }
  for (const name of ['tier0', 'tier1', 'tier2', 'tier3', 'ovf0', 'ovf1', 'ovf2', 'ovf3', 'scene-hdr']) {
    pool.setTextureView(name, { name } as unknown as GPUTextureView);
  }
  pool.setSampler('texSampler', {} as GPUSampler);

  const savedSources = { ...ForwardPass.SHADER_SOURCES };
  const savedUber = ForwardPass.UBER_SOURCE;
  const replaceSources = (next: Record<number, string>) => {
    for (const key of Object.keys(ForwardPass.SHADER_SOURCES)) delete ForwardPass.SHADER_SOURCES[Number(key)];
    Object.assign(ForwardPass.SHADER_SOURCES, next);
  };
  replaceSources(sources);
  ForwardPass.UBER_SOURCE = uber;
  try {
    pass.setup(device, pool);
  } finally {
    replaceSources(savedSources);
    ForwardPass.UBER_SOURCE = savedUber;
  }
  return pool;
}

describe('ForwardPass', () => {
  it('should implement RenderPass interface', () => {
    const pass = new ForwardPass();
    expect(pass.name).toBe('forward');
    expect(pass.reads).toContain('visible-indices');
    expect(pass.reads).toContain('entity-transforms');
    expect(pass.reads).toContain('tex-indices');
    expect(pass.reads).toContain('indirect-args');
    expect(pass.writes).toContain('scene-hdr');
    expect(pass.optional).toBe(false);
  });

  it('should declare render-meta and prim-params as read dependencies', () => {
    const pass = new ForwardPass();
    expect(pass.reads).toContain('render-meta');
    expect(pass.reads).toContain('prim-params');
  });

  it('should start with empty pipeline maps', () => {
    // Nothing is built before setup(): execute() begins no render pass, so it
    // sets no pipeline, and destroying a pass never set up is safe.
    const pass = new ForwardPass();
    const begun: unknown[] = [];
    const encoder = { beginRenderPass: (d: unknown) => { begun.push(d); return {}; } } as unknown as GPUCommandEncoder;
    pass.execute(encoder, { canvasWidth: 64, canvasHeight: 64 } as FrameState, new ResourcePool());
    expect(begun).toEqual([]);
    expect(() => pass.destroy()).not.toThrow();
  });
});

// ForwardPass binds the texture-tier views in group 1. A tier that grows gets a
// new texture and view, and the old texture is destroyed. The bind group must
// follow, or every draw uses a destroyed texture and the frame is dropped.
describe('ForwardPass group 1 follows the texture tiers', () => {
  function setUp() {
    const texture = () => ({ createView: () => ({}), destroy() {} });
    const device = {
      createBuffer: () => ({ destroy() {} }),
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: (d: GPUBindGroupDescriptor) => ({ entries: [...d.entries] }),
      createSampler: () => ({}),
      createTexture: texture,
      queue: { writeBuffer() {}, writeTexture() {} },
    } as unknown as GPUDevice;

    const pass = new ForwardPass();
    const pool = setUpOnPool(pass, device, { 0: 'stub' });

    const frame = { canvasWidth: 64, canvasHeight: 64 } as FrameState;
    const group1Views = () => {
      const bound: Array<{ entries: GPUBindGroupEntry[] }> = [];
      const encoder = {
        beginRenderPass: () => ({
          setPipeline() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexedIndirect() {}, end() {},
          setBindGroup: (i: number, bg: { entries: GPUBindGroupEntry[] }) => { if (i === 1) bound.push(bg); },
        }),
      } as unknown as GPUCommandEncoder;
      pass.execute(encoder, frame, pool);
      expect(bound.length).toBeGreaterThan(0);
      return bound.map((bg) => bg.entries.map((e) => e.resource));
    };
    return { pool, group1Views };
  }

  it('binds the views that are in the pool when it draws', () => {
    const { pool, group1Views } = setUp();
    group1Views();

    const grown = { name: 'tier0 after growth' } as unknown as GPUTextureView;
    pool.setTextureView('tier0', grown);
    for (const views of group1Views()) {
      expect(views).toContain(grown);
    }
  });

  it('keeps the same bind group while nothing changes', () => {
    const { group1Views } = setUp();
    const first = group1Views()[0];
    const second = group1Views()[0];
    expect(second).toEqual(first);
  });
});

/**
 * ForwardPass set up on a recording fake device (setUpOnPool): stub sources
 * for types 0, 1 and 4, and `uberSource` as UBER_SOURCE.
 */
function setUpForward(options?: { lit?: boolean }, uberSource = UBER_STUB) {
  const layouts: GPUBindGroupLayoutDescriptor[] = [];
  const pipelineLayouts: GPUPipelineLayoutDescriptor[] = [];
  const pipelines: GPURenderPipelineDescriptor[] = [];
  const writes: Array<{ buffer: unknown; data: ArrayBuffer }> = [];
  const textures: GPUTextureDescriptor[] = [];
  const buffers: Array<{ size: number; usage: number }> = [];
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => { const b = { size: d.size, usage: d.usage, destroy() {} }; buffers.push(b); return b; },
    createShaderModule: (d: GPUShaderModuleDescriptor) => ({ code: d.code }),
    createSampler: () => ({ sampler: true }),
    createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => { layouts.push(d); return { d }; },
    createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => { pipelineLayouts.push(d); return { d }; },
    createRenderPipeline: (d: GPURenderPipelineDescriptor) => { pipelines.push(d); return { descriptor: d }; },
    createBindGroup: (d: GPUBindGroupDescriptor) => ({ layout: d.layout, entries: [...d.entries] }),
    createTexture: (d: GPUTextureDescriptor) => {
      textures.push(d);
      return { createView: (vd?: GPUTextureViewDescriptor) => ({ placeholderOf: d, vd }), destroy() {} };
    },
    queue: {
      writeBuffer: (buffer: unknown, _o: number, data: ArrayBuffer | ArrayBufferView) => {
        writes.push({ buffer, data: data instanceof ArrayBuffer ? data : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength) });
      },
      writeTexture() {},
    },
  } as unknown as GPUDevice;

  const pass = new ForwardPass(options);
  const pool = setUpOnPool(pass, device, { 0: 'stub', 1: 'stub', 4: 'stub' }, uberSource);

  type Call = { op: string; index?: number; group?: { entries: GPUBindGroupEntry[] }; pipeline?: GPURenderPipelineDescriptor };
  const frame = { canvasWidth: 64, canvasHeight: 64, transparentCount: 1 } as FrameState;
  const draw = (): Call[] => {
    const calls: Call[] = [];
    const encoder = {
      beginRenderPass: () => ({
        setVertexBuffer() {}, setIndexBuffer() {}, drawIndexedIndirect() {}, end() {},
        setPipeline: (p: { descriptor: GPURenderPipelineDescriptor }) => { calls.push({ op: 'pipeline', pipeline: p.descriptor }); },
        setBindGroup: (index: number, group: { entries: GPUBindGroupEntry[] }) => { calls.push({ op: 'group', index, group }); },
      }),
    } as unknown as GPUCommandEncoder;
    pass.execute(encoder, frame, pool);
    return calls;
  };
  const group2Texture = (calls: Call[]) => {
    const bound = calls.filter((c) => c.op === 'group' && c.index === 2);
    expect(bound.length).toBeGreaterThan(0);
    return bound.map((c) => c.group!.entries.find((e) => e.binding === 0)!.resource);
  };
  const prepare = (over: Partial<FrameState> = {}) =>
    pass.prepare(device, { cameraViewProjection: new Float32Array(16), ...over } as FrameState);
  return { pass, pool, layouts, pipelineLayouts, pipelines, writes, textures, draw, group2Texture, buffers, prepare };
}

// Phase 17, Task 10: ForwardPass reads the light buffer through a third bind
// group. Every primitive pipeline shares one layout of three groups. A layout
// may hold groups a shader does not use, but the bind group must still be set
// for every pipeline, or the draw fails validation. With lighting off, group 2
// binds a 1×1 placeholder and the lighting uniform says "disabled".
describe('ForwardPass @group(2): the light buffer', () => {
  it('builds every pipeline on a three-group layout; group 2 is texture, filtering sampler, uniform', () => {
    const { pipelineLayouts, layouts } = setUpForward();
    expect(pipelineLayouts.length).toBeGreaterThan(0);
    for (const pl of pipelineLayouts) expect([...pl.bindGroupLayouts]).toHaveLength(3);
    // Group 0 has 6 entries, group 1 has 9: group 2 is the one with 3.
    const group2 = layouts.find((l) => [...l.entries].length === 3)!;
    const entries = [...group2.entries].sort((a, b) => a.binding - b.binding);
    expect(entries.map((e) => e.binding)).toEqual([0, 1, 2]);
    expect(entries[0].texture?.sampleType ?? 'float').toBe('float');
    expect(entries[1].sampler?.type ?? 'filtering').toBe('filtering');
    expect(entries[2].buffer?.type).toBe('uniform');
    for (const e of entries) expect(e.visibility).toBe(GPUShaderStage.FRAGMENT);
  });

  // Light layers (design 2026-09-26): one light-buffer layer per light group.
  it('group 2 binds the light buffer as a 2d-array, and the placeholder is a 1-layer 2d-array', () => {
    const { layouts, textures, draw, group2Texture } = setUpForward();
    const group2 = layouts.find((l) => [...l.entries].length === 3)!;
    expect([...group2.entries].find((e) => e.binding === 0)!.texture?.viewDimension).toBe('2d-array');
    const placeholder = textures.find((t) => t.format === 'rgba8unorm')!;
    expect(placeholder.textureBindingViewDimension).toBe('2d-array');
    const bound = group2Texture(draw())[0] as unknown as { vd?: GPUTextureViewDescriptor };
    expect(bound.vd?.dimension).toBe('2d-array');
  });

  it('writes the layer→group table every frame, from FrameState.lightGroups', () => {
    const { writes, prepare } = setUpForward({ lit: true });
    prepare({ lightGroups: { layerToGroup: [0x10, 0x2] } as FrameState['lightGroups'] });
    expect([...new Uint32Array(writes.filter((w) => w.data.byteLength === 16).at(-1)!.data)]).toEqual([1, 0x10, 0x2, 0]);
    prepare({});
    expect([...new Uint32Array(writes.filter((w) => w.data.byteLength === 16).at(-1)!.data)]).toEqual([1, 0, 0, 0]);
  });

  it('writes the canvas size into the camera uniform at bytes 68-72 (line widths in pixels)', () => {
    const { writes, prepare } = setUpForward();
    prepare({ canvasWidth: 800, canvasHeight: 600 });
    const camera = writes.filter((w) => w.data.byteLength === 80).at(-1)!;
    expect([...new Float32Array(camera.data, 68, 2)]).toEqual([800, 600]);
  });

  it('the camera uniform is 80 bytes, and the shared layout says so (minBindingSize)', () => {
    const { buffers } = setUpForward();
    expect(buffers.filter((b) => (b.usage & GPUBufferUsage.UNIFORM) !== 0).map((b) => b.size)).toContain(80);
    expect(primitiveGroup0LayoutEntries()[0].buffer?.minBindingSize).toBe(80);
  });

  // LightingUniform is declared once, in the prelude piece, which hot-reloads.
  // Without minBindingSize a prelude edit that grows the struct passes every
  // setup-time check and invalidates every ForwardPass draw at DRAW time; with
  // it, bind-group creation fails inside the probe's error scope instead.
  it('the lighting uniform binding declares minBindingSize = sizeof(LightingUniform), and the buffer has that size', () => {
    const size = structSize(loadPrimitivePieces().prelude, 'LightingUniform');
    expect(size).toBe(16);
    const { layouts, buffers } = setUpForward();
    const group2 = layouts.find((l) => [...l.entries].length === 3)!;
    expect([...group2.entries].find((e) => e.binding === 2)!.buffer?.minBindingSize).toBe(size);
    expect(buffers.filter((b) => (b.usage & GPUBufferUsage.UNIFORM) !== 0).map((b) => b.size)).toContain(size);
  });

  it('sets group 2 for every pipeline it draws, including shaders that ignore it', () => {
    const { draw } = setUpForward();
    const calls = draw();
    const pipelines = calls.filter((c) => c.op === 'pipeline').length;
    // 3 types opaque + ONE uber pipeline for every transparent (design 5b §6.2).
    expect(pipelines).toBe(4);
    expect(calls.filter((c) => c.op === 'group' && c.index === 2)).toHaveLength(pipelines);
  });

  it('without lighting: does not read light-buffer, binds a placeholder, and the uniform says disabled', () => {
    const { pass, pool, writes, draw, group2Texture } = setUpForward();
    expect(pass.reads).not.toContain('light-buffer');
    // A view left in the pool by a lit graph that has since been retired: its
    // texture is destroyed, and binding it would drop the frame.
    const stale = { name: 'stale light buffer' } as unknown as GPUTextureView;
    pool.setTextureView('light-buffer', stale);
    for (const view of group2Texture(draw())) expect(view).not.toBe(stale);
    const uniform = writes.find((w) => w.data.byteLength === 16);
    expect(uniform, 'the 16-byte lighting uniform').toBeDefined();
    expect(new Uint32Array(uniform!.data)[0]).toBe(0);
  });

  it('with lighting: reads light-buffer, binds the pool view, and the uniform says enabled', () => {
    const { pass, pool, writes, draw, group2Texture } = setUpForward({ lit: true });
    expect(pass.reads).toContain('light-buffer');
    const lightBuffer = { name: 'light-buffer' } as unknown as GPUTextureView;
    pool.setTextureView('light-buffer', lightBuffer);
    for (const view of group2Texture(draw())) expect(view).toBe(lightBuffer);
    const uniform = writes.find((w) => w.data.byteLength === 16);
    expect(new Uint32Array(uniform!.data)[0]).toBe(1);
  });

  it('with lighting: follows the light-buffer view when LightGroupsPass recreates it (resize)', () => {
    const { pool, draw, group2Texture } = setUpForward({ lit: true });
    pool.setTextureView('light-buffer', { name: 'before' } as unknown as GPUTextureView);
    draw();
    const resized = { name: 'after resize' } as unknown as GPUTextureView;
    pool.setTextureView('light-buffer', resized);
    for (const view of group2Texture(draw())) expect(view).toBe(resized);
  });
});

// The uber module (design 2026-09-27 §3.2): every primitive type behind one
// pipeline, which draws every transparent (design 5b §6.2). setup() refuses
// to run without it, before it looks at the pool.
describe('ForwardPass requires the uber module', () => {
  it('refuses to set up without an uber module: publishPrimitiveShaders() runs first', () => {
    expect(() => setUpForward({}, '')).toThrow(/UBER_SOURCE/);
  });
});

// ---------------------------------------------------------------------------
// The primitive shaders are composed (render/primitive-shaders.ts, design
// 2026-09-27 §3): the prelude (shared names, bindings, helpers), one library
// per type, generated wrappers. The GPU compiles the composed modules, so every
// check reads them — or the prelude, once, where the text lives there: the
// first check proves every module contains it verbatim. What a library does is
// found through the call graph, never by slicing between entry points, and
// `body` throws on a missing function, so no negative check passes on ''.
// WGSL does not run headless: these pin the source.
const pieces = loadPrimitivePieces();
const prelude = stripComments(pieces.prelude);
const typeModules = composeTypeModules(pieces);
const uber = stripComments(composeUberModule(pieces));

const libOf = (name: PrimitiveLibraryName): PrimitiveLibrary => {
  const lib = PRIMITIVE_LIBRARIES.find((l) => l.name === name);
  if (!lib) throw new Error(`no library '${name}'`);
  return lib;
};
const moduleOf = (name: PrimitiveLibraryName): string => stripComments(typeModules[libOf(name).type]);
const fnOf = (name: PrimitiveLibraryName, suffix: 'vs' | 'fs' | 'occluder' | 'shade'): string => `${libOf(name).prefix}${suffix}`;

/** A function's body; throws when the function is missing. */
function body(src: string, fn: string): string {
  const text = functionBody(src, fn);
  if (text === null) throw new Error(`fn ${fn} not found`);
  return text;
}

describe('the composed primitive modules', () => {
  it('one module per type 0-5 and the uber, each containing the prelude verbatim', () => {
    expect(PRIMITIVE_LIBRARIES.map((l) => l.type)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Object.keys(typeModules).map(Number)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const src of [...Object.values(typeModules), composeUberModule(pieces)]) {
      expect(src.includes(pieces.prelude.trim())).toBe(true);
    }
  });
});

// An untextured entity carries packed texture index 0: tier 0, layer 0, not
// overflow. Layer 0 is reserved and never holds a real texture. It is meant to
// be white, but on a compressed tier (BC7/ASTC) it is never filled, because
// writeTexture cannot take raw pixels there. An all-zero BC7 block decodes to
// transparent black, so every untextured quad drew black on desktop and white
// on an rgba8-only device. The prelude answers index 0 itself
// (sampleTierOrWhite); lines and beziers replace only the colour and keep their
// coverage. MSDF text is the exception: its "texture" is the glyph atlas.
const TIERS = ['tier0Tex', 'tier1Tex', 'tier2Tex', 'tier3Tex', 'ovf0Tex', 'ovf1Tex', 'ovf2Tex', 'ovf3Tex'];
const WHITE_AT_INDEX_0: PrimitiveLibraryName[] = ['quad', 'line', 'bezier'];

describe('packed index 0 is white in every tier-sampling primitive', () => {
  it('sampleTierOrWhite returns white for packed index 0 before it samples a tier', () => {
    const fn = body(prelude, 'sampleTierOrWhite');
    // The untextured check returns white itself, as the per-file shaders did.
    const untextured = fn.search(/in\.isOverflow == 0u && in\.texTier == 0u && in\.texLayer == 0u\s*\)\s*\{\s*return vec4f\(1\.0\);/);
    expect(untextured, 'the untextured early return').toBeGreaterThan(-1);
    expect(fn.indexOf('sampleTier(in)')).toBeGreaterThan(untextured);
    expect(fn).not.toMatch(/textureSample/);
  });

  it('sampleTier is the one function that samples the tiers: all eight, with textureSampleLevel', () => {
    const fn = body(prelude, 'sampleTier');
    for (const tier of TIERS) {
      expect(fn).toMatch(new RegExp(`textureSampleLevel\\(\\s*${tier}\\s*,\\s*texSampler\\s*,\\s*in\\.uv\\s*,\\s*in\\.texLayer\\s*,\\s*0\\.0\\s*\\)`));
    }
    const samplers = [...callGraph(uber)].filter(([, refs]) => TIERS.some((t) => refs.has(t))).map(([name]) => name);
    expect(samplers).toEqual(['sampleTier']);
  });

  it.each(WHITE_AT_INDEX_0)('%s: its coverage function takes the colour from sampleTierOrWhite, never sampleTier', (name) => {
    for (const src of [moduleOf(name), uber]) {
      const refs = callGraph(src).get(fnOf(name, 'shade'));
      expect(refs, fnOf(name, 'shade')).toBeDefined();
      expect(refs!.has('sampleTierOrWhite')).toBe(true);
      expect(refs!.has('sampleTier')).toBe(false);
    }
  });

  // A glyph with index 0 stays what the raw sample gives (on BC7/ASTC
  // transparent black, discarded), not a solid white box.
  it('msdf-text samples the atlas raw, without the white answer', () => {
    for (const src of [moduleOf('msdf-text'), uber]) {
      const refs = callGraph(src).get(fnOf('msdf-text', 'shade'));
      expect(refs, fnOf('msdf-text', 'shade')).toBeDefined();
      expect(refs!.has('sampleTier')).toBe(true);
      expect(reachableFrom(src, fnOf('msdf-text', 'shade')).has('sampleTierOrWhite')).toBe(false);
    }
  });

  it.each(['gradient', 'box-shadow'] as PrimitiveLibraryName[])('%s never samples the tiers', (name) => {
    const reached = reachableFrom(moduleOf(name), 'fs_main');
    expect(reached.has('sampleTier')).toBe(false);
    expect(reached.has('sampleTierOrWhite')).toBe(false);
  });
});

describe('line: pixel widths, anti-aliasing, the half-open stroke', () => {
  const line = moduleOf('line');
  // The uber embeds the same library for the transparent draw: checked in both.
  const both = [line, uber];

  /** The stroke test: line's one `(in: VertexOutput) -> bool` function. */
  const insideStroke = (): string => {
    const m = /fn (line_\w+)\s*\(\s*in\s*:\s*VertexOutput\s*\)\s*->\s*bool/.exec(line);
    if (!m) throw new Error('line has no stroke test: fn line_…(in: VertexOutput) -> bool');
    return m[1];
  };

  it('the camera uniform carries the viewport size at 68/72; line_vs reads the width unit in primParams[7]', () => {
    const camera = /struct CameraUniform\s*\{([\s\S]*?)\}/.exec(prelude)![1]
      .split('\n').map((l) => l.trim()).filter(Boolean);
    // mat4 (64 B), then four 4-byte scalars: occluderLayers at 64, the viewport at 68 and 72.
    expect(camera.slice(0, 4)).toEqual([
      'viewProjection: mat4x4f,', 'occluderLayers: u32,', 'viewportWidth: f32,', 'viewportHeight: f32,',
    ]);
    for (const src of both) expect(body(src, fnOf('line', 'vs'))).toMatch(/primParams\[base \+ 7u\]/);
  });

  it('line_shade takes fwidth before any branch or tier sample', () => {
    // Derivatives need uniform control flow. In the uber the call sits in the
    // type switch, which its diagnostic(off, derivative_uniformity) covers.
    for (const src of both) {
      const shade = body(src, fnOf('line', 'shade'));
      const firstBranch = Math.min(...['switch', 'discard', 'if (', 'sampleTier'].map((k) => shade.indexOf(k)).filter((i) => i >= 0));
      expect(shade.indexOf('fwidth(')).toBeGreaterThanOrEqual(0);
      expect(shade.indexOf('fwidth(')).toBeLessThan(firstBranch);
    }
  });

  it('the AA ramp is measured on the LINEAR uv.y and centred on the edge', () => {
    for (const src of both) {
      const shade = body(src, fnOf('line', 'shade'));
      // fwidth of abs() has a kink at the centre: 2x2-quad derivatives collapse
      // there and a ~2 px line's opacity follows pixel parity.
      expect(shade).toMatch(/fwidth\(\s*in\.uv\.y\s*\)/);
      expect(shade).not.toMatch(/fwidth\(\s*edge\s*\)/);
      // Centred: alpha is 0.5 exactly at the edge, so every fragment inside the
      // quad keeps alpha >= 0.5 and the occluder seed covers the whole stroke.
      expect(shade).toMatch(/smoothstep\(1\.0 - edgeAA \* 0\.5, 1\.0 \+ edgeAA \* 0\.5, edge\)/);
    }
  });

  it('the quad is wider than the stroke, so the OUTER half of the edge ramp is rasterised', () => {
    // Without the margin a pixel centred on the edge depends on the
    // rasteriser's tie rule: a thin transparent line's coverage followed
    // sub-pixel position (1.5 to 2.0 for 2 px, measured on GPU).
    const output = /struct VertexOutput\s*\{([\s\S]*?)\}/.exec(prelude)![1];
    // Interpolated with perspective, not flat: the half-open test compares its last bits.
    expect(output).toMatch(/@location\(6\)\s+edgeScale\s*:\s*f32/);
    expect(output).toMatch(/@location\(7\)\s+@interpolate\(flat\)\s+transparent\s*:\s*u32/);
    const inside = insideStroke();
    for (const src of both) {
      expect(body(src, fnOf('line', 'shade'))).toMatch(/let edge = abs\(in\.uv\.y - 0\.5\) \* 2\.0 \* in\.edgeScale;/);
      const vs = body(src, fnOf('line', 'vs'));
      expect(vs).toMatch(/quadWidth = strokeWidth \+ 1\.0/);
      // From renderMeta bit 8, never hard-wired: the uber draws only
      // transparent lines because of the buckets it is fed, not by construction.
      expect(vs).toMatch(/out\.transparent = select\(0u, 1u, \(renderMeta\[entityIdx \* 2u \+ 1u\] & 0x100u\) != 0u\);/);
      // The opaque pipeline has no blending: there a margin fragment (alpha
      // < 0.5) must be dropped, or opaque lines draw one pixel wider.
      expect(body(src, fnOf('line', 'fs'))).toMatch(new RegExp(`if \\(in\\.transparent == 0u && !${inside}\\(in\\)\\) \\{\\s*discard;`));
      // The seed is exactly the opaque stroke: same half-open test. A texel
      // with no alpha (a textured line) casts nothing either.
      expect(body(src, fnOf('line', 'occluder'))).toMatch(new RegExp(`if \\(color\\.a <= 0\\.0 \\|\\| !${inside}\\(in\\)\\) \\{\\s*discard;`));
    }
  });

  it('the stroke test is half-open, so an opaque W-px stroke covers W pixel rows at any alignment', () => {
    for (const src of both) {
      const fn = body(src, insideStroke());
      // Signed distance, one closed and one open end, both shifted the same way.
      expect(fn).toMatch(/let d = \(in\.uv\.y - 0\.5\) \* 2\.0 \* in\.edgeScale;/);
      expect(fn).toMatch(/return d >= -1\.0 - (\w+) && d < 1\.0 - \1;/);
    }
  });
});

// Which modules apply lighting, and where. ForwardPass binds group 2 (the light
// buffer) for every pipeline, and the prelude declares it in every module: what
// must hold is REACHABILITY. OccluderSeedStage runs the same per-type modules
// through vs_main and fs_occluder on a TWO-group layout, and WebGPU rejects a
// pipeline whose entry point statically uses a binding its layout lacks: the
// lit graph is then rejected and lighting silently stays off. The group-2 names
// come from the prelude's own declarations, plus the helper that reads its table.
const GROUP2 = bindingDecls(prelude).filter((b) => b.group === 2).map((b) => b.name);
const LIGHT_NAMES = [...GROUP2, 'lightGroupOf'];
const reachesLight = (src: string, entry: string): string[] => {
  const reached = reachableFrom(src, entry);
  return LIGHT_NAMES.filter((name) => reached.has(name));
};

/** The uber's fs_main: primitive type → the function its case returns. */
function uberFragmentCases(): Map<number, string> {
  const cases = new Map<number, string>();
  const re = /case\s+(\d+)u\s*(?:,\s*default\s*)?:\s*\{\s*return\s+(\w+)\s*\(\s*in\s*\)\s*;\s*\}/g;
  for (const m of body(uber, 'fs_main').matchAll(re)) cases.set(Number(m[1]), m[2]);
  return cases;
}

describe('lit primitives: group 2 is reached from fs_main of the lit types only', () => {
  it('group 2 is the light buffer, its sampler and the lighting uniform', () => {
    expect([...GROUP2].sort()).toEqual(['lightBuffer', 'lightSampler', 'lighting']);
  });

  it.each(PRIMITIVE_LIBRARIES.map((l): [string, PrimitiveLibrary] => [l.name, l]))(
    '%s: fs_main reaches group 2 exactly when the type is lit; fs_occluder and vs_main never',
    (_name, l) => {
      const src = stripComments(typeModules[l.type]);
      expect(reachesLight(src, 'fs_main').length > 0).toBe(l.lit);
      expect(reachesLight(src, 'fs_occluder')).toEqual([]);
      expect(reachesLight(src, 'vs_main')).toEqual([]);
    },
  );

  it('the uber: every case of fs_main returns its library fs, which reaches group 2 exactly when lit; vs_main never', () => {
    const cases = uberFragmentCases();
    expect([...cases.keys()].sort((a, b) => a - b)).toEqual(PRIMITIVE_LIBRARIES.map((l) => l.type));
    for (const l of PRIMITIVE_LIBRARIES) {
      expect(cases.get(l.type)).toBe(`${l.prefix}fs`);
      expect(reachesLight(uber, `${l.prefix}fs`).length > 0, l.name).toBe(l.lit);
    }
    expect(reachesLight(uber, 'vs_main')).toEqual([]);
  });

  it('applyLighting samples the light buffer gated on lighting.enabled and receivesLight; only the lit fs call it', () => {
    const fn = body(prelude, 'applyLighting');
    expect(fn).toMatch(/textureSampleLevel\s*\(\s*lightBuffer\b/);
    expect(fn).toMatch(/RECEIVES_LIGHT_BIT/);
    expect(fn).toMatch(/lighting\.enabled/);
    const graph = [...callGraph(uber)];
    expect(graph.filter(([, refs]) => refs.has('lightBuffer') || refs.has('lightSampler')).map(([name]) => name))
      .toEqual(['applyLighting']);
    // Never after the uber's switch: the other types would turn lit, which
    // deriveLightGroups does not model.
    expect(graph.filter(([, refs]) => refs.has('applyLighting')).map(([name]) => name).sort())
      .toEqual(PRIMITIVE_LIBRARIES.filter((l) => l.lit).map((l) => `${l.prefix}fs`).sort());
  });

  it('the light buffer is a 2d-array, sampled at the layer of the receiver group: lowest mask bit, 4-bit table', () => {
    expect(prelude).toMatch(/@group\(2\) @binding\(0\) var lightBuffer: texture_2d_array<f32>;/);
    expect(prelude).toMatch(/groupTableLo: u32,\s*groupTableHi: u32,/);
    const fn = body(prelude, 'lightGroupOf');
    expect(fn).toMatch(/firstTrailingBit\(mask\)/);
    expect(fn).toMatch(/0xFu/);
    expect(body(prelude, 'applyLighting')).toMatch(/textureSampleLevel\(lightBuffer, lightSampler, in\.screenUV, lightGroupOf\(/);
  });

  it('RECEIVES_LIGHT_BIT matches RENDER_META_RECEIVES_LIGHT_BIT in components.rs', () => {
    const rust = readFileSync(new URL('../../../../crates/hyperion-core/src/components.rs', import.meta.url), 'utf8');
    const rustBit = Number(/RENDER_META_RECEIVES_LIGHT_BIT: u32 = 1 << (\d+);/.exec(rust)?.[1]);
    const wgslBit = Number(/const RECEIVES_LIGHT_BIT\s*:\s*u32\s*=\s*1u << (\d+)u;/.exec(prelude)?.[1]);
    expect(rustBit).toBe(10);
    expect(wgslBit).toBe(rustBit);
  });
});

// Binding against layout. ForwardPass runs a per-type module's vs_main and
// fs_main on groups 0-2, OccluderSeedStage its vs_main and fs_occluder on
// groups 0-1, and the uber runs on groups 0-2. A binding an entry point reaches
// must be in that layout and visible to that stage: camera, transforms and
// visibleIndices are vertex-only, groups 1 and 2 fragment-only. WebGPU reports
// a violation only at pipeline creation, on a GPU: headless this is the check.
type Layouts = Record<number, GPUBindGroupLayoutEntry[]>;

/** The layouts the primitive pipelines are built with: the shared ones, and ForwardPass's group 2. */
function primitiveLayouts(): Layouts {
  const group2 = setUpForward().layouts.find((l) => [...l.entries].length === 3);
  if (!group2) throw new Error('ForwardPass built no three-entry layout (group 2)');
  return { 0: primitiveGroup0LayoutEntries(), 1: textureTierLayoutEntries(), 2: [...group2.entries] };
}

const DECL = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([^>]+)>)?\s+(\w+)\s*:\s*([^;]+);/g;
const declKind = (space: string | undefined, type: string): string => (space ?? type).replace(/\s+/g, '');
function layoutKind(e: GPUBindGroupLayoutEntry): string {
  if (e.buffer) return e.buffer.type === 'read-only-storage' ? 'storage,read' : (e.buffer.type ?? 'uniform');
  if (e.sampler) return 'sampler';
  if (e.texture) {
    const sample = (e.texture.sampleType ?? 'float') === 'float' ? 'f32' : String(e.texture.sampleType);
    return `texture_${(e.texture.viewDimension ?? '2d').replace('-', '_')}<${sample}>`;
  }
  return 'unknown';
}

/** The bindings `entry` reaches, each checked against `groups` and the stage visibility; returns their names. */
function checkReach(src: string, entry: string, stage: number, groups: number[], layouts: Layouts): string[] {
  const reached = reachableFrom(src, entry);
  const hit = bindingDecls(src).filter((b) => reached.has(b.name));
  for (const b of hit) {
    expect(groups, `${entry} reaches ${b.name} in group ${b.group}`).toContain(b.group);
    const e = layouts[b.group]?.find((x) => x.binding === b.binding);
    expect(e !== undefined && (e.visibility & stage) !== 0, `${b.name} is visible to ${entry}`).toBe(true);
  }
  return hit.map((b) => b.name);
}

describe('every binding an entry point reaches is in its pipeline layout, for its stage', () => {
  it('the layouts: camera, transforms and visibleIndices vertex-only; groups 1 and 2 fragment-only', () => {
    const layouts = primitiveLayouts();
    for (const binding of [0, 1, 2]) {
      expect(layouts[0].find((e) => e.binding === binding)?.visibility).toBe(GPUShaderStage.VERTEX);
    }
    for (const e of [...layouts[1], ...layouts[2]]) expect(e.visibility).toBe(GPUShaderStage.FRAGMENT);
  });

  it('every prelude binding has a layout entry of its kind, and every layout entry a binding', () => {
    const layouts = primitiveLayouts();
    const decls = [...prelude.matchAll(DECL)].map((m) => ({
      group: Number(m[1]), binding: Number(m[2]), name: m[4], kind: declKind(m[3], m[5]),
    }));
    // The regex sees exactly what wgsl-analysis sees.
    expect(decls.map((d) => d.name).sort()).toEqual(bindingDecls(prelude).map((b) => b.name).sort());
    for (const d of decls) {
      const entry = layouts[d.group]?.find((e) => e.binding === d.binding);
      expect(entry, `${d.name} @group(${d.group}) @binding(${d.binding})`).toBeDefined();
      expect(layoutKind(entry!), d.name).toBe(d.kind);
    }
    for (const [group, entries] of Object.entries(layouts)) {
      expect(decls.filter((d) => d.group === Number(group)), `group ${group}`).toHaveLength(entries.length);
    }
  });

  it.each(PRIMITIVE_LIBRARIES.map((l): [string, PrimitiveLibrary] => [l.name, l]))(
    '%s: vs_main, fs_main and fs_occluder stay inside their layouts',
    (_name, l) => {
      const layouts = primitiveLayouts();
      const src = stripComments(typeModules[l.type]);
      // vs_main runs in the ForwardPass pipelines AND the occluder ones: two groups.
      expect(checkReach(src, 'vs_main', GPUShaderStage.VERTEX, [0, 1], layouts)).toContain('visibleIndices');
      checkReach(src, 'fs_main', GPUShaderStage.FRAGMENT, [0, 1, 2], layouts);
      checkReach(src, 'fs_occluder', GPUShaderStage.FRAGMENT, [0, 1], layouts);
    },
  );

  it('the uber: vs_main and fs_main stay inside the ForwardPass layout', () => {
    const layouts = primitiveLayouts();
    const vs = checkReach(uber, 'vs_main', GPUShaderStage.VERTEX, [0, 1, 2], layouts);
    const fs = checkReach(uber, 'fs_main', GPUShaderStage.FRAGMENT, [0, 1, 2], layouts);
    expect(vs).toEqual(expect.arrayContaining(['camera', 'transforms', 'visibleIndices', 'renderMeta']));
    expect(fs).toEqual(expect.arrayContaining(['tier0Tex', 'lightBuffer', 'primParams']));
  });
});

// Phase 5b: ForwardPass reads the transparent sort's outputs in every graph.
// That read is what orders TransparentSortPass before it and keeps it alive:
// the sort is optional, and RadixSortPass was culled because nothing read it.
describe('ForwardPass reads the transparent sort outputs', () => {
  it.each([false, true])('lit=%s: transparent-order and transparent-args are reads', (lit) => {
    const pass = new ForwardPass({ lit });
    expect(pass.reads).toEqual(expect.arrayContaining(['transparent-order', 'transparent-args']));
  });
});

// Design 5b §6.2: the transparent sub-pass is ONE draw. TransparentSortPass
// writes the visible transparents of types 0-5, back to front, into
// `transparent-order` and the draw arguments at byte 0 of `transparent-args`;
// ForwardPass draws them through the uber pipeline, with a second group 0
// whose binding 2 (visibleIndices in the shaders) is the sorted order.
describe('ForwardPass: the uber draw of the sorted transparents', () => {
  interface FakePipeline { desc: GPURenderPipelineDescriptor }
  interface FakeGroup { layout: unknown; entries: GPUBindGroupEntry[] }
  interface Call { op: 'pipeline' | 'group' | 'draw'; pipeline?: FakePipeline; index?: number; group?: FakeGroup; buffer?: unknown; offset?: number }

  /** ForwardPass on a device recording its pipelines and bind groups (setUpOnPool), `omit` left out of the pool. */
  function setUp(omit: string[] = []) {
    const pipelines: FakePipeline[] = [];
    const groups: FakeGroup[] = [];
    const device = {
      createBuffer: () => ({ destroy() {} }),
      createShaderModule: (d: GPUShaderModuleDescriptor) => ({ code: d.code }),
      createSampler: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => ({ groups: [...d.bindGroupLayouts] }),
      createRenderPipeline: (desc: GPURenderPipelineDescriptor) => { const p = { desc }; pipelines.push(p); return p; },
      createBindGroup: (d: GPUBindGroupDescriptor) => { const bg = { layout: d.layout, entries: [...d.entries] }; groups.push(bg); return bg; },
      createTexture: () => ({ createView: () => ({}), destroy() {} }),
      queue: { writeBuffer() {}, writeTexture() {} },
    } as unknown as GPUDevice;

    const pass = new ForwardPass();
    const pool = setUpOnPool(pass, device, { 0: 'quad module', 1: 'line module', 4: 'gradient module' }, 'uber module', { omit });
    const buffer = (name: string): GPUBuffer => pool.getBuffer(name)!;

    const draw = (transparentCount: number): Call[] => {
      const calls: Call[] = [];
      const encoder = {
        beginRenderPass: () => ({
          setVertexBuffer() {}, setIndexBuffer() {}, end() {},
          setPipeline: (pipeline: FakePipeline) => { calls.push({ op: 'pipeline', pipeline }); },
          setBindGroup: (index: number, group: FakeGroup) => { calls.push({ op: 'group', index, group }); },
          drawIndexedIndirect: (buf: unknown, offset: number) => { calls.push({ op: 'draw', buffer: buf, offset }); },
        }),
      } as unknown as GPUCommandEncoder;
      pass.execute(encoder, { canvasWidth: 64, canvasHeight: 64, transparentCount } as FrameState, pool);
      return calls;
    };
    const uber = () => pipelines.find((p) => (p.desc.vertex.module as unknown as { code: string }).code === 'uber module');
    const binding = (group: FakeGroup, b: number) => (group.entries.find((e) => e.binding === b)!.resource as GPUBufferBinding).buffer;
    return { pipelines, groups, buffer, draw, uber, binding };
  }

  it('builds one opaque pipeline per type and ONE uber pipeline, with the transparent descriptor', () => {
    const { pipelines, uber } = setUp();
    expect(pipelines).toHaveLength(4); // 3 types opaque + the uber
    const u = uber();
    expect(u, 'a pipeline built from UBER_SOURCE').toBeDefined();
    const blended = pipelines.filter((p) => [...p.desc.fragment!.targets][0]!.blend);
    expect(blended).toEqual([u]);
    const d = u!.desc;
    expect(d.vertex.entryPoint).toBe('vs_main');
    expect(d.fragment!.entryPoint).toBe('fs_main');
    expect([...d.fragment!.targets][0]!.format).toBe(SCENE_HDR_FORMAT);
    expect([...d.fragment!.targets][0]!.blend).toEqual({
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    });
    expect(d.depthStencil).toEqual({ format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' });
    expect(d.primitive).toEqual({ topology: 'triangle-list', cullMode: 'back' });
    expect([...d.vertex.buffers!][0]).toEqual({ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] });
    // The same three-group layout as every opaque pipeline.
    for (const p of pipelines) expect(p.desc.layout).toBe(d.layout);
    expect((d.layout as unknown as { groups: unknown[] }).groups).toHaveLength(3);
  });

  it('builds a second group 0: bindGroup0 with binding 2 = transparent-order', () => {
    const { groups, buffer, binding } = setUp();
    const group0s = groups.filter((g) => g.entries.length === 6);
    expect(group0s).toHaveLength(2);
    const plain = group0s.find((g) => binding(g, 2) === buffer('visible-indices'));
    const sorted = group0s.find((g) => binding(g, 2) === buffer('transparent-order'));
    expect(plain, 'group 0 on visible-indices').toBeDefined();
    expect(sorted, 'group 0 on transparent-order').toBeDefined();
    expect(sorted!.layout).toBe(plain!.layout);
    for (const b of [0, 1, 3, 4, 5]) expect(binding(sorted!, b)).toBe(binding(plain!, b));
  });

  it('draws every transparent with ONE drawIndexedIndirect(transparent-args, 0), after the opaque draws', () => {
    const { draw, buffer, uber, binding } = setUp();
    const calls = draw(5);
    const draws = calls.filter((c) => c.op === 'draw');
    // Opaque: 3 types x 2 material buckets, from buckets 0-13 of indirect-args.
    const opaque = draws.filter((c) => c.buffer === buffer('indirect-args'));
    expect(opaque).toHaveLength(3 * BUCKETS_PER_TYPE);
    for (const c of opaque) expect(c.offset!).toBeLessThan(OPAQUE_DRAW_BUCKETS * 20);
    const transparent = draws.filter((c) => c.buffer === buffer('transparent-args'));
    expect(transparent).toEqual([{ op: 'draw', buffer: buffer('transparent-args'), offset: 0 }]);
    expect(draws.at(-1)).toBe(transparent[0]);
    // Its state: the uber pipeline, the sorted group 0, groups 1 and 2.
    const at = calls.indexOf(transparent[0]);
    const lastPipeline = calls.slice(0, at).filter((c) => c.op === 'pipeline').at(-1)!;
    expect(lastPipeline.pipeline).toBe(uber());
    const since = calls.slice(calls.indexOf(lastPipeline), at);
    const group = (n: number) => since.filter((c) => c.op === 'group' && c.index === n).at(-1)?.group;
    expect(binding(group(0)!, 2)).toBe(buffer('transparent-order'));
    expect(group(1), 'group 1 set for the uber draw').toBeDefined();
    expect(group(2), 'group 2 set for the uber draw').toBeDefined();
  });

  it('skips the uber draw when nothing is transparent (FrameState.transparentCount 0)', () => {
    const { draw, buffer, uber } = setUp();
    const calls = draw(0);
    expect(calls.filter((c) => c.op === 'draw' && c.buffer === buffer('transparent-args'))).toHaveLength(0);
    expect(calls.some((c) => c.op === 'pipeline' && c.pipeline === uber())).toBe(false);
    expect(calls.filter((c) => c.op === 'draw' && c.buffer === buffer('indirect-args'))).toHaveLength(3 * BUCKETS_PER_TYPE);
  });

  it('never binds transparent-args: in a render pass it is an INDIRECT buffer only', () => {
    const { groups, buffer, draw } = setUp();
    draw(3);
    for (const g of groups) for (const e of g.entries) {
      expect((e.resource as GPUBufferBinding).buffer).not.toBe(buffer('transparent-args'));
    }
  });

  it('fails loudly in setup without the renderer-owned sort buffers', () => {
    expect(() => setUp(['transparent-order'])).toThrow(/transparent-order/);
    expect(() => setUp(['transparent-args'])).toThrow(/transparent-args/);
  });
});
