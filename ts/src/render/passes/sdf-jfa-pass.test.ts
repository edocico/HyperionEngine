import { describe, it, expect, beforeAll } from 'vitest';
import { SdfJfaPass } from './sdf-jfa-pass';
import { JFAPass } from './jfa-pass';
import type { FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import sdfShaderSource from '../../shaders/sdf-jfa.wgsl?raw';

// The signed-SDF chain (Phase 17, Task 8) floods `occluder-seed` into a field
// where every pixel knows its nearest pixel of the OPPOSITE kind. For a pixel
// outside an occluder that is the nearest occluder pixel; for a pixel inside,
// the nearest free one. The sign comes from the pixel's own kind, kept in
// alpha. That is Godot's single-chain trick: a neighbour of the other kind acts
// as its own seed, so the inside and outside fronts flood together.
// It is 1+JFA: one extra step-1 pass before the standard chain, which also
// converts the raw seed into the signed state (LOAD_PASS).

function recordSetup(pass: SdfJfaPass) {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { COPY_DST: 0x8, UNIFORM: 0x40 };
  g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
  const modules: string[] = [];
  const pipelines: GPURenderPipelineDescriptor[] = [];
  const writes: ArrayBuffer[] = [];
  const device = {
    createBuffer: () => ({ destroy() {} }),
    createSampler: () => ({}),
    createShaderModule: (d: GPUShaderModuleDescriptor) => { modules.push(d.code); return {}; },
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: (d: GPURenderPipelineDescriptor) => { pipelines.push(d); return { getBindGroupLayout: () => ({}) }; },
    queue: { writeBuffer: (_b: GPUBuffer, _o: number, data: ArrayBuffer) => { writes.push(data); } },
  } as unknown as GPUDevice;
  pass.setup(device, {} as ResourcePool);
  return { device, modules, pipelines, writes };
}

describe('SdfJfaPass chain (1+JFA)', () => {
  beforeAll(() => { SdfJfaPass.SHADER_SOURCE = sdfShaderSource; });

  it('runs one step-1 pass, then power-of-two steps down to 1', () => {
    const chain = SdfJfaPass.chain(400);
    const standard = JFAPass.iterationsForDimension(400);
    expect(chain).toHaveLength(standard + 1);
    expect(chain.map((p) => p.stepSize)).toEqual([1, 256, 128, 64, 32, 16, 8, 4, 2, 1]);
    expect(SdfJfaPass.chainLength(400)).toBe(chain.length);
  });

  // The chain is composed once, and the canvas can be resized afterwards.
  // With steps derived from the size at composition (floor(maxDim / 2^i)),
  // a canvas grown by even a few texels left far texels unreached: invalid,
  // so the light march read them as "no occluder" and their shadows vanished
  // (review 2026-09-26). Power-of-two steps reach 2^m - 1 texels, so ONE chain
  // covers every size up to 2^m, and only a change of bracket needs a new one.
  it('reaches every texel of any target up to the next power of two', () => {
    for (const maxDim of [1, 2, 3, 100, 400, 511, 512, 513, 960, 1300, 4096]) {
      const reach = SdfJfaPass.chain(maxDim).slice(1).reduce((sum, p) => sum + p.stepSize, 0);
      const bracket = 2 ** JFAPass.iterationsForDimension(maxDim);
      expect(reach, `maxDim ${maxDim}`).toBeGreaterThanOrEqual(bracket - 1);
      // ...so a resize inside the bracket keeps the same chain.
      expect(SdfJfaPass.chainLength(bracket)).toBe(SdfJfaPass.chainLength(maxDim));
    }
  });

  it('reads occluder-seed first and then each previous iteration, over two physical textures', () => {
    const chain = SdfJfaPass.chain(64);
    expect(chain[0].reads).toEqual(['occluder-seed']);
    chain.forEach((p, i) => {
      expect(p.writes).toEqual([`sdf-iter-${i}`]);
      if (i > 0) expect(p.reads).toEqual([`sdf-iter-${i - 1}`]);
      expect(p.outputPhysical).toBe(i % 2);
      expect(p.optional).toBe(true);
    });
    expect(SdfJfaPass.finalOutputResource(chain.length)).toBe(`sdf-iter-${chain.length - 1}`);
  });

  it('names its passes apart from the outline chain, and is not mistaken for it', () => {
    const chain = SdfJfaPass.chain(64);
    const names = chain.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith('sdf-'))).toBe(true);
    // renderer.ts collects the outline chain with `instanceof JFAPass`.
    expect(chain.some((p) => (p as unknown) instanceof JFAPass)).toBe(false);
  });

  it('converts the raw seed only in the first pass (LOAD_PASS)', () => {
    const chain = SdfJfaPass.chain(64);
    const constants = chain.map((p) => recordSetup(p).pipelines[0].fragment?.constants?.LOAD_PASS);
    expect(constants[0]).toBe(1);
    expect(constants.slice(1).every((c) => c === 0)).toBe(true);
  });

  it('compiles its own shader, never the outline one', () => {
    const savedOutline = JFAPass.SHADER_SOURCE;
    const savedSdf = SdfJfaPass.SHADER_SOURCE;
    JFAPass.SHADER_SOURCE = 'outline jfa';
    SdfJfaPass.SHADER_SOURCE = 'signed sdf';
    try {
      const { modules } = recordSetup(SdfJfaPass.chain(64)[0]);
      expect(modules).toEqual(['signed sdf']);
    } finally {
      JFAPass.SHADER_SOURCE = savedOutline;
      SdfJfaPass.SHADER_SOURCE = savedSdf;
    }
  });

  it('steps in texels of the half-resolution target, the size occluder-seed has', () => {
    const pass = SdfJfaPass.chain(64)[1];
    const { device, writes } = recordSetup(pass);
    pass.prepare(device, { canvasWidth: 801, canvasHeight: 600 } as FrameState);
    const f32 = new Float32Array(writes.at(-1)!);
    expect(f32[0]).toBe(pass.stepSize);
    expect(f32[1]).toBeCloseTo(1 / 400, 9);
    expect(f32[2]).toBeCloseTo(1 / 300, 9);
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
