import { describe, it, expect, beforeAll } from 'vitest';
import { SdfChainStage } from './sdf-chain-stage';
import { JFAPass } from './jfa-pass';
import { JFA_FORMAT } from '../formats';
import type { ResourcePool } from '../resource-pool';
import sdfShaderSource from '../../shaders/sdf-jfa.wgsl?raw';

// SdfChainStage floods an occluder seed into the signed SDF (1+JFA, Godot's
// single chain: every texel ends up knowing its nearest texel of the opposite
// kind). A stage of LightGroupsPass, run once per SDF set over the SAME
// ping-pong pair. Its length comes from the target size each frame, so a
// resize never needs a new graph.

function setUp() {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { COPY_DST: 0x8, UNIFORM: 0x40 };
  g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
  const pipelines: Array<{ desc: GPURenderPipelineDescriptor }> = [];
  const buffers: Array<{ size: number; destroyed: boolean }> = [];
  const bindGroups: GPUBindGroupDescriptor[] = [];
  const writes: Array<{ buffer: unknown; data: ArrayBuffer }> = [];
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => { const b = { size: d.size, destroyed: false, destroy() { b.destroyed = true; } }; buffers.push(b); return b; },
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: (desc: GPURenderPipelineDescriptor) => { const p = { desc }; pipelines.push(p); return p; },
    createBindGroup: (d: GPUBindGroupDescriptor) => { bindGroups.push(d); return { entries: [...d.entries] }; },
    queue: {
      writeBuffer: (buffer: unknown, _o: number, data: ArrayBuffer | ArrayBufferView) => {
        writes.push({ buffer, data: data instanceof ArrayBuffer ? data : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength) });
      },
    },
  } as unknown as GPUDevice;
  const stage = new SdfChainStage();
  stage.setup(device, {} as ResourcePool);
  const encode = (seed: GPUTextureView, a: GPUTextureView, b: GPUTextureView) => {
    const passes: Array<{ target: GPUTextureView; pipeline: unknown; input: unknown }> = [];
    const encoder = {
      beginRenderPass: (desc: GPURenderPassDescriptor) => {
        const rec = { target: [...desc.colorAttachments][0]!.view as GPUTextureView, pipeline: null as unknown, input: null as unknown };
        passes.push(rec);
        return {
          setPipeline: (p: unknown) => { rec.pipeline = p; },
          setBindGroup: (_i: number, bg: { entries: GPUBindGroupEntry[] }) => { rec.input = bg.entries.find((e) => e.binding === 0)!.resource; },
          draw() {}, end() {},
        };
      },
    } as unknown as GPUCommandEncoder;
    const final = stage.encode(encoder, seed, a, b);
    return { passes, final };
  };
  return { stage, device, pipelines, buffers, bindGroups, writes, encode };
}

const view = (name: string) => ({ name }) as unknown as GPUTextureView;

describe('SdfChainStage', () => {
  beforeAll(() => { SdfChainStage.SHADER_SOURCE = sdfShaderSource; });

  it('a step-1 load pass, then power-of-two steps down to 1', () => {
    expect(SdfChainStage.steps(400)).toEqual([1, 256, 128, 64, 32, 16, 8, 4, 2, 1]);
    expect(SdfChainStage.chainLength(400)).toBe(10);
  });

  it('reaches every texel of any target up to the next power of two', () => {
    for (const maxDim of [1, 2, 3, 100, 400, 511, 512, 513, 960, 1300, 4096]) {
      const reach = SdfChainStage.steps(maxDim).slice(1).reduce((sum, s) => sum + s, 0);
      expect(reach, `maxDim ${maxDim}`).toBeGreaterThanOrEqual(2 ** JFAPass.iterationsForDimension(maxDim) - 1);
    }
  });

  it('builds two pipelines into JFA_FORMAT: LOAD_PASS on for the first step, off for the rest', () => {
    const { pipelines } = setUp();
    expect(pipelines.map((p) => p.desc.fragment?.constants?.LOAD_PASS).sort()).toEqual([0, 1]);
    for (const p of pipelines) expect([...(p.desc.fragment?.targets ?? [])][0]?.format).toBe(JFA_FORMAT);
  });

  it('writes one 256-byte slice per step, once: stepSize and the texel size of the target', () => {
    const { stage, device, writes, buffers } = setUp();
    stage.prepare(device, 64, 32);
    const steps = SdfChainStage.steps(64);
    const params = buffers.filter((b) => !b.destroyed).at(-1)!;
    expect(params.size).toBe(steps.length * 256);
    const mine = writes.filter((w) => w.buffer === params);
    expect(mine).toHaveLength(1);
    steps.forEach((step, i) => {
      const f = new Float32Array(mine[0].data, i * 256, 4);
      expect(f[0]).toBe(step);
      expect(f[1]).toBeCloseTo(1 / 64, 9);
      expect(f[2]).toBeCloseTo(1 / 32, 9);
    });
  });

  it('runs every step ping-ponging a/b, the first reading the seed, and returns the final texture', () => {
    const { stage, device, pipelines, encode } = setUp();
    stage.prepare(device, 64, 32);   // maxDim 64: 1 + 6 steps
    const seed = view('seed'), a = view('a'), b = view('b');
    const { passes, final } = encode(seed, a, b);
    expect(passes).toHaveLength(7);
    expect(passes.map((p) => p.target)).toEqual([a, b, a, b, a, b, a]);
    expect(passes.map((p) => p.input)).toEqual([seed, a, b, a, b, a, b]);
    expect(final).toBe(a);
    const load = pipelines.find((p) => p.desc.fragment?.constants?.LOAD_PASS === 1);
    expect(passes[0].pipeline).toBe(load);
    expect(passes.slice(1).every((p) => p.pipeline !== load)).toBe(true);
  });

  it('an even-length chain ends on b', () => {
    const { stage, device, encode } = setUp();
    stage.prepare(device, 100, 50);  // maxDim 100: 1 + 7 steps
    const { passes, final } = encode(view('seed'), view('a'), view('b'));
    expect(passes).toHaveLength(8);
    expect((final as unknown as { name: string }).name).toBe('b');
  });

  it('reuses its bind groups while the views do not change', () => {
    const { stage, device, bindGroups, encode } = setUp();
    stage.prepare(device, 64, 32);
    const seed = view('seed'), a = view('a'), b = view('b');
    encode(seed, a, b);
    const made = bindGroups.length;
    encode(seed, a, b);
    expect(bindGroups.length).toBe(made);
  });
});

describe('sdf-jfa.wgsl', () => {
  it('reads seeds with textureLoad: filtering would blend seed coordinates', () => {
    expect(sdfShaderSource).toMatch(/textureLoad\s*\(/);
    expect(sdfShaderSource).not.toMatch(/textureSample/);
  });

  it('declares the LOAD_PASS override, off by default', () => {
    expect(sdfShaderSource).toMatch(/override LOAD_PASS\s*:\s*bool\s*=\s*false;/);
  });
});
