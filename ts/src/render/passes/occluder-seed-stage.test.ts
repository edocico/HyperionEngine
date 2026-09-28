import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OccluderSeedStage, halfResolution } from './occluder-seed-stage';
import { ResourcePool } from '../resource-pool';
import { JFA_FORMAT } from '../formats';
import type { FrameState } from '../render-pass';
import { PRIMITIVE_LIBRARIES, composeTypeModules, composeUberModule, type PrimitiveLibrary } from '../primitive-shaders';
import { loadPrimitivePieces } from '../primitive-pieces.fixture';
import { callGraph, functionBody, reachableFrom, stripComments } from '../../shaders/wgsl-analysis';

// OccluderSeedStage rasterises the occluders of ONE SDF set into the seed
// texture (light layers, design 2026-09-26). It runs each primitive's own
// module through `fs_occluder`, so a caster shadows its real coverage. The
// set's layers ride in the camera uniform (CameraUniform.occluderLayers), one
// 256-byte slice per set, all written once per frame.

const OCCLUDER_SHADER = 'fn fs_occluder(in: VertexOutput) -> @location(0) vec4f { return vec4f(0.0); }';

function setUp(sources: Record<number, string>) {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100 };
  g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

  const pipelines: GPURenderPipelineDescriptor[] = [];
  const buffers: Array<{ size: number; usage: number; destroyed: boolean }> = [];
  const bindGroups: GPUBindGroupDescriptor[] = [];
  const writes: Array<{ buffer: unknown; data: ArrayBuffer }> = [];
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => {
      const b = { size: d.size, usage: d.usage, destroyed: false, destroy() { b.destroyed = true; } };
      buffers.push(b);
      return b;
    },
    createShaderModule: (d: GPUShaderModuleDescriptor) => ({ code: d.code }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: (d: GPURenderPipelineDescriptor) => { pipelines.push(d); return { d }; },
    createBindGroup: (d: GPUBindGroupDescriptor) => { bindGroups.push(d); return { entries: [...d.entries] }; },
    queue: {
      writeBuffer: (buffer: unknown, _o: number, data: ArrayBuffer | ArrayBufferView) => {
        writes.push({ buffer, data: data instanceof ArrayBuffer ? data : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength) });
      },
    },
  } as unknown as GPUDevice;

  const pool = new ResourcePool();
  for (const name of ['entity-transforms', 'visible-indices', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params']) {
    pool.setBuffer(name, {} as GPUBuffer);
  }
  for (const name of ['tier0', 'tier1', 'tier2', 'tier3', 'ovf0', 'ovf1', 'ovf2', 'ovf3']) {
    pool.setTextureView(name, { name } as unknown as GPUTextureView);
  }
  pool.setSampler('texSampler', {} as GPUSampler);

  const stage = new OccluderSeedStage(sources);
  stage.setup(device, pool);
  const frame = { cameraViewProjection: new Float32Array(16).fill(2) } as unknown as FrameState;
  const camera = () => buffers.filter((b) => (b.usage & GPUBufferUsage.UNIFORM) !== 0 && !b.destroyed).at(-1)!;

  const encode = (s: number, target: GPUTextureView) => {
    const rec = { desc: null as GPURenderPassDescriptor | null, draws: [] as number[], group0: [] as Array<{ entries: GPUBindGroupEntry[] }> };
    const encoder = {
      beginRenderPass: (desc: GPURenderPassDescriptor) => {
        rec.desc = desc;
        return {
          setPipeline() {}, setVertexBuffer() {}, setIndexBuffer() {}, end() {},
          setBindGroup: (i: number, bg: { entries: GPUBindGroupEntry[] }) => { if (i === 0) rec.group0.push(bg); },
          drawIndexedIndirect: (_b: GPUBuffer, offset: number) => { rec.draws.push(offset); },
        };
      },
    } as unknown as GPUCommandEncoder;
    stage.encode(encoder, s, target, pool);
    return rec;
  };
  return { stage, device, pipelines, bindGroups, writes, frame, camera, encode };
}

const view = (name: string) => ({ name }) as unknown as GPUTextureView;
const sets = [{ occluderLayers: 0b01 }, { occluderLayers: 0b10 }];

describe('OccluderSeedStage', () => {
  it('builds one occluder pipeline per primitive with fs_occluder, OCCLUDER_PASS on, into JFA_FORMAT', () => {
    const { pipelines } = setUp({ 0: OCCLUDER_SHADER, 1: 'no occluder entry', 3: OCCLUDER_SHADER });
    expect(pipelines).toHaveLength(2);
    for (const p of pipelines) {
      expect(p.vertex.constants).toEqual({ OCCLUDER_PASS: 1 });
      expect(p.fragment?.entryPoint).toBe('fs_occluder');
      expect([...(p.fragment?.targets ?? [])][0]?.format).toBe(JFA_FORMAT);
    }
  });

  it('writes the FULL canvas size into every slice at byte 68, so a pixel-wide line casts what it draws', () => {
    const { stage, device, writes, camera } = setUp({ 0: OCCLUDER_SHADER });
    const frame = { cameraViewProjection: new Float32Array(16), canvasWidth: 1600, canvasHeight: 900 } as unknown as FrameState;
    stage.prepare(device, frame, sets);
    const mine = writes.filter((w) => w.buffer === camera()).at(-1)!;
    sets.forEach((_, i) => expect([...new Float32Array(mine.data, i * 256 + 68, 2)]).toEqual([1600, 900]));
  });

  it('writes one 256-byte camera slice per set, once, with its occluder layers at byte 64', () => {
    const { stage, device, frame, writes, camera } = setUp({ 0: OCCLUDER_SHADER });
    stage.prepare(device, frame, sets);
    expect(camera().size).toBe(2 * 256);
    const mine = writes.filter((w) => w.buffer === camera());
    expect(mine).toHaveLength(1);
    sets.forEach((s, i) => {
      expect(new Float32Array(mine[0].data, i * 256, 16)[0]).toBe(2);
      expect(new Uint32Array(mine[0].data, i * 256 + 64, 1)[0]).toBe(s.occluderLayers);
    });
  });

  it('encode(s) binds camera slice s: offset s * 256, the 80 bytes of CameraUniform', () => {
    const { stage, device, frame, encode } = setUp({ 0: OCCLUDER_SHADER });
    stage.prepare(device, frame, sets);
    const rec = encode(1, view('seed'));
    const cameraEntry = rec.group0[0].entries.find((e) => e.binding === 0)!;
    expect(cameraEntry.resource).toMatchObject({ offset: 256, size: 80 });
  });

  // Review 2026-09-26: a caster marked `.transparent()` sits in the
  // transparent buckets (14-27), which the seed never drew, so it cast nothing
  // while the grouping counted it (and could pay a flood for an empty seed).
  // fs_occluder casts the coverage above alpha 0.5 whatever the blend mode.
  it('clears the target to "no occluder" and draws both blend modes of each occluder type', () => {
    const { stage, device, frame, encode } = setUp({ 0: OCCLUDER_SHADER, 3: OCCLUDER_SHADER });
    stage.prepare(device, frame, sets);
    const target = view('seed');
    const rec = encode(0, target);
    const attachment = [...rec.desc!.colorAttachments][0]!;
    expect(attachment.view).toBe(target);
    expect(attachment.clearValue).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    // Types 0 and 3: opaque (type*2+b)*20, transparent (14+type*2+b)*20.
    expect([...rec.draws].sort((a, b) => a - b)).toEqual([0, 20, 120, 140, 280, 300, 400, 420]);
  });

  it('reuses the per-set bind group, and rebuilds it when the camera buffer grows', () => {
    const { stage, device, frame, encode } = setUp({ 0: OCCLUDER_SHADER });
    stage.prepare(device, frame, sets.slice(0, 1));
    const a = encode(0, view('seed')).group0[0];
    expect(encode(0, view('seed')).group0[0]).toBe(a);
    stage.prepare(device, frame, sets);
    expect(encode(0, view('seed')).group0[0]).not.toBe(a);
  });
});

describe('halfResolution', () => {
  it('is half the canvas, rounded down, at least 1x1', () => {
    expect(halfResolution(801, 600)).toEqual([400, 300]);
    expect(halfResolution(1, 1)).toEqual([1, 1]);
  });
});

// ---------------------------------------------------------------------------
// The primitive modules are composed (render/primitive-shaders.ts). What every
// module shares lives once in the prelude and is checked there
// (forward-pass.test.ts checks that each module contains it verbatim); the
// generated wrappers are checked on each per-type module; the library's
// coverage function through the call graph.
const pieces = loadPrimitivePieces();
const prelude = stripComments(pieces.prelude);
const typeModules = composeTypeModules(pieces);
const perType = PRIMITIVE_LIBRARIES.map(
  (l): [string, PrimitiveLibrary, string] => [l.name, l, stripComments(typeModules[l.type])],
);

/** A function's body; throws when the function is missing. */
function body(src: string, fn: string): string {
  const text = functionBody(src, fn);
  if (text === null) throw new Error(`fn ${fn} not found`);
  return text;
}

describe('the prelude: the occluder switch, the castsShadow bit, the occluder layers', () => {
  it('declares OCCLUDER_PASS, default false: the ForwardPass pipelines fold the check away', () => {
    expect(prelude).toMatch(/override OCCLUDER_PASS\s*:\s*bool\s*=\s*false;/);
  });

  it('agrees with Rust on the castsShadow bit of renderMeta', () => {
    const rust = readFileSync(new URL('../../../../crates/hyperion-core/src/components.rs', import.meta.url), 'utf8');
    const rustBit = Number(/RENDER_META_CASTS_SHADOW_BIT: u32 = 1 << (\d+);/.exec(rust)?.[1]);
    const wgslBit = Number(/const CASTS_SHADOW_BIT\s*:\s*u32\s*=\s*1u << (\d+)u;/.exec(prelude)?.[1]);
    expect(rustBit).toBe(9);
    expect(wgslBit).toBe(rustBit);
  });

  // Light layers (design 2026-09-26): an occluder shadows only the layers in
  // its mask, so a set's seed holds only its casters. The set's layers ride in
  // the camera uniform, which every module shares with ForwardPass.
  it('carries the set layers in the camera uniform; castsInto reads the mask, 0 = every layer', () => {
    expect(prelude).toMatch(/struct CameraUniform\s*\{\s*viewProjection: mat4x4f,[^}]*occluderLayers: u32,/);
    expect(prelude).toMatch(/fn castsInto\(meta1: u32, layers: u32\) -> bool/);
    const casts = body(prelude, 'castsInto');
    expect(casts).toMatch(/select\(meta1 >> 16u, 0xFFFFu, \(meta1 >> 16u\) == 0u\)/);
    expect(casts).toContain('CASTS_SHADOW_BIT');
  });
});

// Every primitive ForwardPass draws must cast its own shape (design §6.2).
// Light2D (type 6) has no module and is not an occluder.
describe('every per-type module can cast its shape', () => {
  it('the composer yields one module per type 0-5, and none for Light2D', () => {
    expect(Object.keys(typeModules).map(Number)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(typeModules[6]).toBeUndefined();
  });

  it('OccluderSeedStage builds an occluder pipeline from every composed module, and none from the uber', () => {
    const { pipelines } = setUp(composeTypeModules(pieces));
    expect(pipelines).toHaveLength(6);
    for (const p of pipelines) {
      expect(p.vertex.constants).toEqual({ OCCLUDER_PASS: 1 });
      expect(p.fragment?.entryPoint).toBe('fs_occluder');
    }
    // The stage picks modules by the TEXT `fn fs_occluder`: a piece whose
    // comment named it would make the uber look like a caster, and its
    // pipeline fail (the lit graph rejected, lighting silently off).
    expect(setUp({ 0: composeUberModule(pieces) }).pipelines).toHaveLength(0);
  });

  it.each(perType)('%s: vs_main drops non-casters when OCCLUDER_PASS is set, then tags the type', (_name, l, src) => {
    const vs = body(src, 'vs_main');
    expect(vs).toMatch(/if \(OCCLUDER_PASS && !castsInto\(renderMeta\[entityIdx \* 2u \+ 1u\], camera\.occluderLayers\)\)\s*\{\s*return culledVertex\(\);\s*\}/);
    expect(vs).toMatch(new RegExp(`out\\.primType\\s*=\\s*${l.type}u?\\s*;`));
    expect(callGraph(src).get('vs_main')?.has(`${l.prefix}vs`)).toBe(true);
  });

  it.each(perType)('%s: fs_occluder is an entry point, and it and fs_main reach the same coverage function', (_name, l, src) => {
    expect(typeModules[l.type]).toMatch(/@fragment\s+fn fs_occluder\s*\(/);
    const graph = callGraph(src);
    expect(graph.get('fs_main')?.has(`${l.prefix}fs`)).toBe(true);
    expect(graph.get('fs_occluder')?.has(`${l.prefix}occluder`)).toBe(true);
    // One coverage function behind both, so the shadow is exactly what is drawn.
    const shade = `${l.prefix}shade`;
    expect(reachableFrom(src, 'fs_main').has(shade)).toBe(true);
    expect(reachableFrom(src, 'fs_occluder').has(shade)).toBe(true);
  });
});
