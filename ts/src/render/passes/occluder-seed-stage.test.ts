import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OccluderSeedStage, halfResolution } from './occluder-seed-stage';
import { ResourcePool } from '../resource-pool';
import { JFA_FORMAT } from '../formats';
import type { FrameState } from '../render-pass';
import basicShaderSource from '../../shaders/basic.wgsl?raw';

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

describe('basic.wgsl occluder entry', () => {
  it('drops non-casters in the vertex stage only when the pipeline asks for it', () => {
    // Default false: the ForwardPass pipelines constant-fold the check away.
    expect(basicShaderSource).toMatch(/override OCCLUDER_PASS\s*:\s*bool\s*=\s*false;/);
  });

  it('agrees with Rust on the castsShadow bit of renderMeta', () => {
    const rust = readFileSync(new URL('../../../../crates/hyperion-core/src/components.rs', import.meta.url), 'utf8');
    const rustBit = Number(/RENDER_META_CASTS_SHADOW_BIT: u32 = 1 << (\d+);/.exec(rust)?.[1]);
    const wgslBit = Number(/const CASTS_SHADOW_BIT\s*:\s*u32\s*=\s*1u << (\d+)u;/.exec(basicShaderSource)?.[1]);
    expect(rustBit).toBe(9);
    expect(wgslBit).toBe(rustBit);
  });

  it('exposes fs_occluder', () => {
    expect(basicShaderSource).toMatch(/fn fs_occluder\s*\(/);
  });
});

// Every primitive ForwardPass draws must cast its own shape (design §6.2).
// Light2D (type 6) has no shader and is not an occluder.
const primitiveShaders = import.meta.glob(
  ['../../shaders/basic.wgsl', '../../shaders/line.wgsl', '../../shaders/gradient.wgsl',
   '../../shaders/box-shadow.wgsl', '../../shaders/bezier.wgsl', '../../shaders/msdf-text.wgsl'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

describe('every primitive shader can cast its shape', () => {
  it('finds the six primitive shaders', () => {
    expect(Object.keys(primitiveShaders)).toHaveLength(6);
  });

  // Light layers (design 2026-09-26): an occluder shadows only the layers in
  // its mask, so a set's seed holds only its casters. The set's layers ride in
  // the camera uniform, which every primitive shader shares with ForwardPass.
  it.each(Object.entries(primitiveShaders))('%s seeds only the occluders of the set being drawn', (_file, src) => {
    expect(src).toMatch(/struct CameraUniform\s*\{\s*viewProjection: mat4x4f,[^}]*occluderLayers: u32,/);
    expect(src).toMatch(/fn castsInto\(meta1: u32, layers: u32\) -> bool/);
    // Mask 0 means every layer, for an occluder.
    expect(src).toMatch(/select\(meta1 >> 16u, 0xFFFFu, \(meta1 >> 16u\) == 0u\)/);
    expect(src).toMatch(/if \(OCCLUDER_PASS && !castsInto\(renderMeta\[entityIdx \* 2u \+ 1u\], camera\.occluderLayers\)\)/);
  });

  it.each(Object.entries(primitiveShaders))('%s has the occluder entry, the override, and the castsShadow bit', (_file, src) => {
    expect(src).toMatch(/override OCCLUDER_PASS\s*:\s*bool\s*=\s*false;/);
    expect(src).toMatch(/const CASTS_SHADOW_BIT\s*:\s*u32\s*=\s*1u << 9u;/);
    expect(src).toMatch(/@fragment\s*\n\s*fn fs_occluder\s*\(/);
    // fs_main and fs_occluder share one coverage function, so the shadow is
    // exactly what is drawn.
    const shared = /fn (\w+)\(in: VertexOutput\) -> vec4f \{/.exec(src)?.[1];
    expect(shared, 'a shared coverage function').toBeDefined();
    const body = (entry: string) => src.slice(src.indexOf(`fn ${entry}`), src.indexOf('}', src.indexOf(`fn ${entry}`)));
    expect(body('fs_main')).toContain(`${shared}(in)`);
    expect(src.slice(src.indexOf('fn fs_occluder'))).toContain(`${shared}(in)`);
  });
});
