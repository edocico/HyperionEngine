import { describe, it, expect, beforeAll } from 'vitest';
import { LightAccumStage, LIGHT2D_ARG_SLOTS, SLICE } from './light-accum-stage';
import { ResourcePool } from '../resource-pool';
import { SCENE_HDR_FORMAT } from '../formats';
import type { FrameState } from '../render-pass';
import lightShaderSource from '../../shaders/light-accum.wgsl?raw';

// LightAccumStage accumulates the visible Light2Ds of ONE light group into one
// layer of the light buffer (design 2026-09-26). Every group has its own
// 256-byte uniform slice, written once per frame: a writeBuffer between the
// render passes of one frame would land only with its last write.

function setUp() {
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
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: (d: GPURenderPipelineDescriptor) => { pipelines.push(d); return {}; },
    createBindGroup: (d: GPUBindGroupDescriptor) => { bindGroups.push(d); return { d }; },
    queue: {
      writeBuffer: (buffer: unknown, _o: number, data: ArrayBuffer | ArrayBufferView) => {
        writes.push({ buffer, data: data instanceof ArrayBuffer ? data : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength) });
      },
    },
  } as unknown as GPUDevice;

  const pool = new ResourcePool();
  for (const name of ['entity-transforms', 'visible-indices', 'indirect-args', 'render-meta', 'prim-params']) {
    pool.setBuffer(name, { name } as unknown as GPUBuffer);
  }
  const stage = new LightAccumStage();
  stage.setup(device, pool);
  const frame = (over: Partial<FrameState> = {}) =>
    ({ canvasWidth: 800, canvasHeight: 600, cameraViewProjection: new Float32Array(16), ...over }) as FrameState;
  const uniform = () => buffers.filter((b) => (b.usage & GPUBufferUsage.UNIFORM) !== 0 && !b.destroyed).at(-1)!;

  const encode = (g: number, target: GPUTextureView, sdf: GPUTextureView, f = frame()) => {
    const passes: Array<{ desc: GPURenderPassDescriptor; draws: number[]; groups: unknown[] }> = [];
    const encoder = {
      beginRenderPass: (desc: GPURenderPassDescriptor) => {
        const rec = { desc, draws: [] as number[], groups: [] as unknown[] };
        passes.push(rec);
        return {
          setPipeline() {}, setVertexBuffer() {}, setIndexBuffer() {}, end() {},
          setBindGroup: (_i: number, bg: unknown) => { rec.groups.push(bg); },
          drawIndexedIndirect: (_b: GPUBuffer, offset: number) => { rec.draws.push(offset); },
        };
      },
    } as unknown as GPUCommandEncoder;
    stage.encode(encoder, g, target, sdf, f);
    return passes[0];
  };
  return { stage, device, pipelines, buffers, bindGroups, writes, frame, uniform, encode };
}

const view = (name: string) => ({ name }) as unknown as GPUTextureView;
const groups3 = [{ layers: 0b001, sdfSet: 0 }, { layers: 0b010, sdfSet: 1 }, { layers: 0b100, sdfSet: -1 }];

describe('LightAccumStage', () => {
  beforeAll(() => { LightAccumStage.SHADER_SOURCE = lightShaderSource; });

  it('writes one 256-byte slice per group, once, with the group layers at byte 76', () => {
    const { stage, device, writes, uniform, frame } = setUp();
    stage.prepare(device, frame({ shadowSteps: 12 }), groups3);
    expect(SLICE).toBe(256);
    expect(uniform().size).toBe(3 * 256);
    const mine = writes.filter((w) => w.buffer === uniform());
    expect(mine).toHaveLength(1);
    groups3.forEach((g, i) => {
      expect(new Uint32Array(mine[0].data, i * 256 + 76, 1)[0]).toBe(g.layers);
      expect(new Uint32Array(mine[0].data, i * 256 + 64, 1)[0]).toBe(12);
    });
  });

  it('binds slice g: offset g * 256, the 80 bytes of LightUniform', () => {
    const { stage, device, frame, bindGroups, encode } = setUp();
    stage.prepare(device, frame(), groups3);
    encode(2, view('layer2'), view('sdf'));
    const entry = [...bindGroups.at(-1)!.entries].find((e) => e.binding === 0)!;
    expect(entry.resource).toMatchObject({ offset: 2 * 256, size: 80 });
  });

  it('clears its target to the ambient light and draws the Light2D buckets', () => {
    const { stage, device, frame, encode } = setUp();
    stage.prepare(device, frame(), groups3);
    const target = view('layer0');
    const pass = encode(0, target, view('sdf'), frame({ ambient: [0.2, 0.4, 0.6, 0.5] }));
    const attachment = [...pass.desc.colorAttachments][0]!;
    expect(attachment.view).toBe(target);
    expect(attachment.loadOp).toBe('clear');
    expect(attachment.clearValue).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    expect(LIGHT2D_ARG_SLOTS).toEqual([12, 13]);
    expect(pass.draws).toEqual([240, 260]);
  });

  it('reuses a group bind group until its SDF view or the uniform buffer changes', () => {
    const { stage, device, frame, encode } = setUp();
    stage.prepare(device, frame(), groups3);
    const sdf = view('sdf');
    const first = encode(0, view('t'), sdf).groups[0];
    expect(encode(0, view('t'), sdf).groups[0]).toBe(first);
    expect(encode(0, view('t'), view('other sdf')).groups[0]).not.toBe(first);
    // More groups: a bigger buffer, so every cached group is stale.
    const again = encode(0, view('t'), sdf).groups[0];
    stage.prepare(device, frame(), [...groups3, { layers: 0b1000, sdfSet: -1 }]);
    expect(encode(0, view('t'), sdf).groups[0]).not.toBe(again);
  });

  it('grows the uniform buffer with the groups, and never shrinks it', () => {
    const { stage, device, frame, uniform } = setUp();
    stage.prepare(device, frame(), groups3);
    const big = uniform();
    stage.prepare(device, frame(), groups3.slice(0, 1));
    expect(uniform()).toBe(big);
    expect(big.destroyed).toBe(false);
  });

  it('blends additively into an HDR target', () => {
    const { pipelines } = setUp();
    const target = [...(pipelines[0].fragment?.targets ?? [])][0]!;
    expect(target.format).toBe(SCENE_HDR_FORMAT);
    expect(target.blend?.color).toEqual({ operation: 'add', srcFactor: 'one', dstFactor: 'one' });
  });
});

describe('light-accum.wgsl: the group filter', () => {
  it('LightUniform carries the group layers in its last scalar', () => {
    expect(lightShaderSource).toMatch(/sourceFraction: f32,(?:\s|\/\/[^\n]*)*groupLayers: u32,\s*\};/);
  });

  it('a light whose mask misses the group emits a degenerate triangle', () => {
    const vs = lightShaderSource.slice(lightShaderSource.indexOf('fn vs_main'), lightShaderSource.indexOf('fn sdfDistance'));
    expect(vs).toMatch(/if \(\(\(renderMeta\[e \* 2u \+ 1u\] >> 16u\) & u\.groupLayers\) == 0u\)/);
    expect(vs.indexOf('u.groupLayers')).toBeLessThan(vs.indexOf('lightType(e)'));
  });
});

describe('light-accum.wgsl', () => {
  it('reads the SDF with textureLoad: filtering would blend seed coordinates', () => {
    expect(lightShaderSource).toMatch(/textureLoad\s*\(\s*sdf\b/);
    expect(lightShaderSource).not.toMatch(/textureSample[^L]/);
  });

  it('uses the original Quilez soft-shadow term, not the Aaltonen correction', () => {
    // The correction assumes an exact SDF. A jump-flood field over-estimates,
    // and y = h*h / (2*ph) amplifies that (design §7.3, A2).
    expect(lightShaderSource).toMatch(/res\s*=\s*min\(\s*res\s*,\s*h\s*\/\s*\(\s*\(\s*t\s*-\s*start\s*\)\s*\*\s*angle\s*\)\s*\)/);
    expect(lightShaderSource).not.toMatch(/h\s*\*\s*h\s*\/\s*\(\s*2\.0\s*\*/);
  });

  it('a march that runs out of steps extrapolates its last clearance to the light, never assumes "lit"', () => {
    // A ray hugging a long wall advances by 1-2 texels and can spend all its
    // steps before it proves anything. Returning the running `res` then lit
    // pixels squarely behind the wall (a leak above its top, at 24 steps).
    // Returning 0 would darken long rays through open space instead. Assume
    // the clearance stays the last one seen, all the way to the light.
    const fn = lightShaderSource.slice(lightShaderSource.indexOf('fn shadow'), lightShaderSource.indexOf('@fragment'));
    const afterLoop = fn.slice(fn.indexOf('t += h;'));  // the loop's last statement onwards
    expect(afterLoop).toMatch(/if\s*\(\s*t\s*<\s*travel\s*\)/);
    expect(afterLoop).toMatch(/min\(\s*res\s*,\s*h\s*\/\s*\(\s*\(\s*travel\s*-\s*start\s*\)\s*\*\s*angle\s*\)\s*\)/);
  });

  it('a pixel inside an occluder leaves it and keeps marching: only its OWN occluder does not shadow it', () => {
    // A sprite that both casts and receives (a character, a crate) is inside
    // the SDF. Returning "lit" there skipped every other occluder too: the
    // character stood fully lit in a wall's shadow (review 2026-09-26). Inside,
    // |h| is a lower bound on the way out, so stepping by it never overshoots.
    const fn = lightShaderSource.slice(lightShaderSource.indexOf('fn shadow'), lightShaderSource.indexOf('@fragment'));
    expect(fn).not.toMatch(/if\s*\(\s*h0\s*<=\s*0\.0\s*\)\s*\{\s*return\s+1\.0\s*;/);
    expect(fn).toMatch(/while\s*\(\s*h\s*<=\s*0\.0/);
    // Penumbra distances are measured from where the ray leaves, or a sprite
    // would go dark along its own outline.
    expect(fn).toMatch(/let\s+start\s*=\s*t\s*;/);
  });

  it("caps the light's apparent size by its real one: min(1/k, sourceRadius / distance)", () => {
    // k alone makes the light's ANGULAR size constant, i.e. a light whose
    // radius grows with the pixel's distance (R = D/k). A light beside a wall
    // then darkened pixels on the far side: the last steps of their march pass
    // within h of the wall. Measured 2026-09-26: free rays 23-42% darker.
    expect(lightShaderSource).toMatch(/min\(\s*1\.0\s*\/\s*u\.shadowHardness\s*,\s*sourceRadius\s*\/\s*travel\s*\)/);
  });
});
