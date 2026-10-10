import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { LightAccumStage, LIGHT_BLEND, MIN_LIGHT_ORDER_CAPACITY, SLICE } from './light-accum-stage';
import { ResourcePool } from '../resource-pool';
import { SCENE_HDR_FORMAT } from '../formats';
import { BLEND_MIX } from '../light-groups';
import type { FrameState } from '../render-pass';
import lightShaderSource from '../../shaders/light-accum.wgsl?raw';
import { bindingDecls, callGraph, functionBody, functionParams, reachableFrom, stripComments } from '../../shaders/wgsl-analysis';
import { structSize } from '../../shaders/uniform-layout';

// LightAccumStage accumulates the lights of ONE light group into one layer of
// the light buffer (design 2026-09-26). Every group has its own 256-byte
// uniform slice, written once per frame: a writeBuffer between the render
// passes of one frame would land only with its last write. Since round step 7
// every group draws the frame's ONE light list (deriveLightGroups), in one
// direct draw, through ONE pipeline with a premultiplied "over" blend.

const POOL_BUFFERS = ['entity-transforms', 'visible-indices', 'indirect-args', 'render-meta', 'prim-params'];

function setUp(poolBuffers = POOL_BUFFERS) {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100 };
  g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

  const pipelines: GPURenderPipelineDescriptor[] = [];
  const buffers: Array<{ size: number; usage: number; label?: string; destroyed: boolean }> = [];
  const bindGroups: GPUBindGroupDescriptor[] = [];
  const writes: Array<{ buffer: unknown; offset: number; data: ArrayBuffer }> = [];
  const layouts: GPUBindGroupLayoutDescriptor[] = [];
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => {
      const b = { size: d.size, usage: d.usage, label: d.label, destroyed: false, destroy() { b.destroyed = true; } };
      buffers.push(b);
      return b;
    },
    createShaderModule: () => ({}),
    createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => { layouts.push(d); return {}; },
    createPipelineLayout: () => ({}),
    createRenderPipeline: (d: GPURenderPipelineDescriptor) => { pipelines.push(d); return {}; },
    createBindGroup: (d: GPUBindGroupDescriptor) => { bindGroups.push(d); return { d }; },
    queue: {
      // dataOffset and size count elements for a typed array, bytes for an ArrayBuffer (WebGPU's rule).
      writeBuffer: (buffer: unknown, offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number) => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const unit = data instanceof ArrayBuffer ? 1 : ((data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1);
        const start = dataOffset * unit;
        writes.push({ buffer, offset, data: bytes.slice(start, size === undefined ? bytes.length : start + size * unit).buffer });
      },
    },
  } as unknown as GPUDevice;

  const pool = new ResourcePool();
  /** The pool's buffers, by name: the stage must never destroy one (an HMR probe runs setup() then destroy()). */
  const poolBuffer = new Map<string, { name: string; destroyed: boolean; destroy(): void }>();
  for (const name of poolBuffers) {
    const b = { name, destroyed: false, destroy() { b.destroyed = true; } };
    poolBuffer.set(name, b);
    pool.setBuffer(name, b as unknown as GPUBuffer);
  }
  const stage = new LightAccumStage();
  stage.setup(device, pool);
  const frame = (over: Partial<FrameState> = {}) =>
    ({ canvasWidth: 800, canvasHeight: 600, cameraViewProjection: new Float32Array(16), ...over }) as FrameState;
  const uniform = () => buffers.filter((b) => (b.usage & GPUBufferUsage.UNIFORM) !== 0 && !b.destroyed).at(-1)!;
  /** The light list's buffer: the stage's only STORAGE buffer. */
  const list = () => buffers.filter((b) => (b.usage & GPUBufferUsage.STORAGE) !== 0 && !b.destroyed).at(-1)!;

  const encode = (g: number, target: GPUTextureView, sdf: GPUTextureView, f = frame()) => {
    const passes: Array<{ desc: GPURenderPassDescriptor; draws: number[]; indexed: number[][]; groups: unknown[] }> = [];
    const encoder = {
      beginRenderPass: (desc: GPURenderPassDescriptor) => {
        const rec = { desc, draws: [] as number[], indexed: [] as number[][], groups: [] as unknown[] };
        passes.push(rec);
        return {
          setPipeline() {}, setVertexBuffer() {}, setIndexBuffer() {}, end() {},
          setBindGroup: (_i: number, bg: unknown) => { rec.groups.push(bg); },
          drawIndexedIndirect: (_b: GPUBuffer, offset: number) => { rec.draws.push(offset); },
          drawIndexed: (...args: number[]) => { rec.indexed.push(args); },
        };
      },
    } as unknown as GPUCommandEncoder;
    stage.encode(encoder, g, target, sdf, f);
    return passes[0];
  };
  return { stage, device, pipelines, buffers, bindGroups, writes, layouts, pool, poolBuffer, frame, uniform, list, encode };
}

/** drawIndexed's five arguments, WebGPU's defaults filled in. */
const direct = (args: number[]) => [args[0], args[1] ?? 1, args[2] ?? 0, args[3] ?? 0, args[4] ?? 0];
/** The resource a recorded bind group (the mock returns { d: descriptor }) binds at `binding`. */
const bindingOf = (bg: unknown, binding: number) =>
  [...(bg as { d: GPUBindGroupDescriptor }).d.entries].find((e) => e.binding === binding)!.resource;
/** A frame without lights. */
const NO_LIGHTS = new Uint32Array(0);
/** A frame's light list: slots in draw order. */
const lights = (...slots: number[]) => Uint32Array.from(slots);

const view = (name: string) => ({ name }) as unknown as GPUTextureView;
const groups3 = [{ layers: 0b001, sdfSet: 0 }, { layers: 0b010, sdfSet: 1 }, { layers: 0b100, sdfSet: -1 }];

describe('LightAccumStage', () => {
  beforeAll(() => { LightAccumStage.SHADER_SOURCE = lightShaderSource; });

  it('writes one 256-byte slice per group, once, with the group layers at byte 76', () => {
    const { stage, device, writes, uniform, frame } = setUp();
    stage.prepare(device, frame({ shadowSteps: 12 }), groups3, NO_LIGHTS);
    expect(SLICE).toBe(256);
    expect(uniform().size).toBe(3 * 256);
    const mine = writes.filter((w) => w.buffer === uniform());
    expect(mine).toHaveLength(1);
    groups3.forEach((g, i) => {
      expect(new Uint32Array(mine[0].data, i * 256 + 76, 1)[0]).toBe(g.layers);
      expect(new Uint32Array(mine[0].data, i * 256 + 64, 1)[0]).toBe(12);
    });
  });

  it("caps shadowSteps at 2^30 - 1: the sun's budget 4u * u.shadowSteps never wraps in u32", () => {
    // Wrapped, the sun got 0 steps at 2^30 (review wf_cf354af4-c53 [1]): its
    // shadows vanished, and every pixel near a caster darkened, upwind too.
    // The multiplier comes from the shader, so the cap and the 4x stay tied.
    const { stage, device, writes, uniform, frame } = setUp();
    const sunMultiplier = Number(/(\d+)u \* u\.shadowSteps/.exec(body('sunShadow'))?.[1]);
    expect(sunMultiplier).toBe(4);
    const written = (shadowSteps: number) => {
      stage.prepare(device, frame({ shadowSteps }), groups3, NO_LIGHTS);
      return new Uint32Array(writes.filter((w) => w.buffer === uniform()).at(-1)!.data, 64, 1)[0];
    };
    for (const s of [2 ** 30, 2 ** 31, 3 * 2 ** 30, 2 ** 30 + 5, 2 ** 32 + 7, 0x3fffffff]) {
      const v = written(s);
      expect(v, `shadowSteps ${s}`).toBe(0x3fffffff);
      expect(sunMultiplier * v, `the sun's budget at shadowSteps ${s}`).toBeLessThanOrEqual(0xffffffff);
    }
    expect(written(48)).toBe(48);
    expect(written(48.5)).toBe(48);  // a whole number of steps
  });

  it('binding 0 declares minBindingSize = sizeof(LightUniform): a buffer too small fails at bind-group creation, not at draw time', () => {
    const { layouts } = setUp();
    const entry = [...layouts[0].entries].find((e) => e.binding === 0)!;
    expect(entry.buffer?.minBindingSize).toBe(structSize(lightShaderSource, 'LightUniform'));
  });

  it('binds slice g: offset g * 256, the 80 bytes of LightUniform', () => {
    const { stage, device, frame, bindGroups, encode } = setUp();
    stage.prepare(device, frame(), groups3, NO_LIGHTS);
    encode(2, view('layer2'), view('sdf'));
    const entry = [...bindGroups.at(-1)!.entries].find((e) => e.binding === 0)!;
    expect(entry.resource).toMatchObject({ offset: 2 * 256, size: 80 });
  });

  // Round step 7: every light comes from deriveLightGroups' list, in its order
  // (add and sub, then mix; world z back to front; external id), one DIRECT
  // draw per group. No indirect record, so no indirect-first-instance, and
  // `.transparent()` or a tier > 0 texture no longer moves a light later.
  it('clears its target to the ambient light, then draws the whole list in one direct draw, firstInstance 0', () => {
    const { stage, device, frame, encode } = setUp();
    stage.prepare(device, frame(), groups3, lights(5, 9, 2));
    const target = view('layer0');
    const pass = encode(0, target, view('sdf'), frame({ ambient: [0.2, 0.4, 0.6, 0.5] }));
    const attachment = [...pass.desc.colorAttachments][0]!;
    expect(attachment.view).toBe(target);
    expect(attachment.loadOp).toBe('clear');
    expect(attachment.clearValue).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    expect(pass.draws).toEqual([]);
    expect(pass.indexed.map(direct)).toEqual([[6, 3, 0, 0, 0]]);
  });

  it('draws the same list into every group: the vertex stage drops a light whose mask misses the group', () => {
    const { stage, device, frame, encode } = setUp();
    stage.prepare(device, frame(), groups3, lights(5, 9, 2));
    for (let g = 0; g < groups3.length; g++) {
      expect(encode(g, view(`layer${g}`), view('sdf')).indexed.map(direct), `group ${g}`).toEqual([[6, 3, 0, 0, 0]]);
    }
  });

  it('an empty list still clears the layer to the ambient, and draws nothing', () => {
    const { stage, device, frame, encode } = setUp();
    stage.prepare(device, frame(), groups3, NO_LIGHTS);
    const pass = encode(0, view('layer0'), view('sdf'), frame({ ambient: [0.2, 0.4, 0.6, 0.5] }));
    expect([...pass.desc.colorAttachments][0]!.clearValue).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    expect(pass.indexed).toEqual([]);
    expect(pass.draws).toEqual([]);
  });

  it("never draws an earlier frame's list: a frame without lights draws none", () => {
    const { stage, device, frame, encode } = setUp();
    stage.prepare(device, frame(), groups3, lights(5, 9));
    expect(encode(0, view('layer0'), view('sdf')).indexed.map(direct)).toEqual([[6, 2, 0, 0, 0]]);
    stage.prepare(device, frame(), groups3, NO_LIGHTS);
    const pass = encode(0, view('layer0'), view('sdf'));
    expect(pass.indexed).toEqual([]);
    expect(pass.draws).toEqual([]);
  });

  it('writes the list once per frame, in prepare(), at offset 0; encode() writes nothing', () => {
    const { stage, device, frame, writes, list, encode } = setUp();
    stage.prepare(device, frame(), groups3, lights(5, 9, 2));
    const mine = writes.filter((w) => w.buffer === list());
    expect(mine).toHaveLength(1);
    expect(mine[0].offset).toBe(0);
    expect([...new Uint32Array(mine[0].data)]).toEqual([5, 9, 2]);
    const before = writes.length;
    for (let g = 0; g < groups3.length; g++) encode(g, view(`layer${g}`), view('sdf'));
    expect(writes.length).toBe(before);
  });

  it('binding 2 is the list: vertex-only read-only storage with minBindingSize 4, a stage-private buffer', () => {
    const { stage, device, frame, layouts, list, pool, poolBuffer, encode } = setUp();
    const entry = [...layouts[0].entries].find((e) => e.binding === 2)!;
    expect(entry.visibility).toBe(GPUShaderStage.VERTEX);
    expect(entry.buffer).toEqual({ type: 'read-only-storage', minBindingSize: 4 });
    expect(pool.getBuffer('light-order')).toBeUndefined();
    stage.prepare(device, frame(), groups3, NO_LIGHTS);
    expect(pool.getBuffer('light-order')).toBeUndefined();
    // Created in setup(): every bind group is valid from the first frame, an empty one included.
    expect(list()).toMatchObject({ size: MIN_LIGHT_ORDER_CAPACITY * 4, label: 'light-order' });
    const bound = (bindingOf(encode(0, view('t'), view('sdf')).groups[0], 2) as GPUBufferBinding).buffer;
    expect(bound).toBe(list());
    expect([...poolBuffer.values()]).not.toContain(bound);
  });

  it('an HMR probe on the same pool (setup(), then destroy()) leaves the live stage its own list buffer', () => {
    // renderer.ts probes a reloaded shader with a throwaway LightGroupsPass on
    // the LIVE pool: a list buffer registered there, or shared, would die with it.
    const { stage, device, frame, pool, list, encode } = setUp();
    const own = list();
    const probe = new LightAccumStage();
    probe.setup(device, pool);
    probe.destroy();
    stage.prepare(device, frame(), groups3, lights(5, 9, 2));
    const bound = (bindingOf(encode(0, view('t'), view('sdf')).groups[0], 2) as GPUBufferBinding).buffer;
    expect(bound).toBe(own);
    expect(own.destroyed).toBe(false);
    expect(pool.getBuffer('light-order')).toBeUndefined();
  });

  it('grows the list buffer to the next power of two, never shrinks it, and rebuilds the cached bind groups only when it grows', () => {
    const { stage, device, frame, list, encode } = setUp();
    const sdf = view('sdf');
    stage.prepare(device, frame(), groups3, lights(1, 2, 3));
    const small = list();
    const first = encode(0, view('t'), sdf).groups[0];
    stage.prepare(device, frame(), groups3, new Uint32Array(1000));
    const big = list();
    expect(small.destroyed).toBe(true);
    expect(big.size).toBe(1024 * 4);
    const grown = encode(0, view('t'), sdf).groups[0];
    expect(grown).not.toBe(first);
    expect((bindingOf(grown, 2) as GPUBufferBinding).buffer).toBe(big);
    stage.prepare(device, frame(), groups3, lights(1, 2));
    expect(list()).toBe(big);
    expect(encode(0, view('t'), sdf).groups[0]).toBe(grown);
  });

  it('creates the list buffer STORAGE | COPY_DST, in setup() and when it grows: prepare() fills it with writeBuffer', () => {
    // The mock writeBuffer checks no usage: without COPY_DST at either site
    // every other test passes, and only the GPU rejects the write.
    const { stage, device, frame, buffers } = setUp();
    const created = () => buffers.filter((b) => b.label === 'light-order').map((b) => ({ size: b.size, usage: b.usage }));
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    expect(created()).toEqual([{ size: MIN_LIGHT_ORDER_CAPACITY * 4, usage }]);
    stage.prepare(device, frame(), groups3, new Uint32Array(MIN_LIGHT_ORDER_CAPACITY + 1));
    expect(created()).toEqual([{ size: MIN_LIGHT_ORDER_CAPACITY * 4, usage }, { size: MIN_LIGHT_ORDER_CAPACITY * 8, usage }]);
  });

  it('reuses a group bind group until its SDF view or the uniform buffer changes', () => {
    const { stage, device, frame, encode } = setUp();
    stage.prepare(device, frame(), groups3, NO_LIGHTS);
    const sdf = view('sdf');
    const first = encode(0, view('t'), sdf).groups[0];
    expect(encode(0, view('t'), sdf).groups[0]).toBe(first);
    expect(encode(0, view('t'), view('other sdf')).groups[0]).not.toBe(first);
    // More groups: a bigger buffer, so every cached group is stale.
    const again = encode(0, view('t'), sdf).groups[0];
    stage.prepare(device, frame(), [...groups3, { layers: 0b1000, sdfSet: -1 }], NO_LIGHTS);
    expect(encode(0, view('t'), sdf).groups[0]).not.toBe(again);
  });

  it('grows the uniform buffer with the groups, and never shrinks it', () => {
    const { stage, device, frame, uniform } = setUp();
    stage.prepare(device, frame(), groups3, NO_LIGHTS);
    const big = uniform();
    stage.prepare(device, frame(), groups3.slice(0, 1), NO_LIGHTS);
    expect(uniform()).toBe(big);
    expect(big.destroyed).toBe(false);
  });

  it('needs neither visible-indices nor indirect-args from the pool', () => {
    const { stage, device, frame, encode } = setUp(['entity-transforms', 'render-meta', 'prim-params']);
    stage.prepare(device, frame(), groups3, lights(1));
    expect(encode(0, view('t'), view('sdf')).indexed.map(direct)).toEqual([[6, 1, 0, 0, 0]]);
  });

  it('destroy() destroys the list buffer and no pool buffer', () => {
    const { stage, device, frame, list, poolBuffer } = setUp();
    stage.prepare(device, frame(), groups3, lights(1, 2));
    const mine = list();
    stage.destroy();
    expect(mine.destroyed).toBe(true);
    for (const [name, b] of poolBuffer) expect(b.destroyed, name).toBe(false);
  });

  it('one pipeline, premultiplied "over" into an HDR target: rgb + dst·(1 − a), and the alpha keeps the clear value', () => {
    // A fragment alpha of 0 (add, sub) keeps dst whole: dst + c, what
    // {one, one} gave. Alpha w (mix): dst·(1 − w) + target·w.
    const { pipelines } = setUp();
    expect(pipelines).toHaveLength(1);
    const target = [...(pipelines[0].fragment?.targets ?? [])][0]!;
    expect(target.format).toBe(SCENE_HDR_FORMAT);
    expect(target.blend).toBe(LIGHT_BLEND);
    expect(LIGHT_BLEND).toEqual({
      color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
    });
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

/** The comment-blanked body of `fn name` in light-accum.wgsl; fails the test when the function is missing. */
function body(name: string): string {
  const text = functionBody(lightShaderSource, name);
  expect(text, `fn ${name} in light-accum.wgsl`).not.toBeNull();
  return text!;
}

describe('light-accum.wgsl', () => {
  it('reads the SDF with textureLoad: filtering would blend seed coordinates', () => {
    expect(lightShaderSource).toMatch(/textureLoad\s*\(\s*sdf\b/);
    expect(lightShaderSource).not.toMatch(/textureSample[^L]/);
  });

  it('uses the original Quilez soft-shadow term, not the Aaltonen correction', () => {
    // The correction assumes an exact SDF. A jump-flood field over-estimates,
    // and y = h*h / (2*ph) amplifies that (design §7.3, A2).
    expect(body('shadow')).toMatch(/let\s+q\s*=\s*h\s*\/\s*\(\s*\(\s*t\s*-\s*start\s*\)\s*\*\s*angle\s*\)/);
    expect(lightShaderSource).not.toMatch(/h\s*\*\s*h\s*\/\s*\(\s*2\.0\s*\*/);
  });

  it('a march that runs out of steps extrapolates its last clearance to the end of the ray, never assumes "lit"', () => {
    // A ray hugging a long wall advances by 1-2 texels and can spend all its
    // steps before it proves anything (a leak above its top, at 24 steps).
    const march = body('shadow');
    const afterLoop = march.slice(march.indexOf('t += h;'));  // the loop's last statement onwards
    expect(afterLoop).toMatch(/if\s*\(\s*t\s*<\s*travel\s*\)/);
    expect(afterLoop).toMatch(/h\s*\/\s*\(\s*\(\s*travel\s*-\s*start\s*\)\s*\*\s*angle\s*\)/);
  });

  it('a pixel inside an occluder leaves it and keeps marching: only its OWN occluder does not shadow it', () => {
    const march = body('shadow');
    expect(march).not.toMatch(/if\s*\(\s*h0\s*<=\s*0\.0\s*\)\s*\{\s*return\s+1\.0\s*;/);
    expect(march).toMatch(/while\s*\(\s*h\s*<=\s*0\.0/);
    expect(march).toMatch(/let\s+start\s*=\s*t\s*;/);
  });

  it("caps a point or spot light's apparent size by its real one: min(1/k, sourceRadius / distance)", () => {
    expect(body('pointShadow')).toMatch(/min\(\s*1\.0\s*\/\s*u\.shadowHardness\s*,\s*sourceRadius\s*\/\s*travel\s*\)/);
  });

  it('the march is shared: shadow(origin, dir, travel, angle, fadeReach, steps), and pointShadow hands it no fade and the plain budget', () => {
    expect(functionParams(lightShaderSource, 'shadow')).toEqual(['origin', 'dir', 'travel', 'angle', 'fadeReach', 'steps']);
    // u.shadowSteps, as before step 6: point and spot lights march exactly as they did.
    expect(body('pointShadow')).toMatch(/return\s+shadow\(\s*origin\s*,\s*dir\s*,\s*travel\s*,\s*angle\s*,\s*0\.0\s*,\s*u\.shadowSteps\s*\)/);
    const calls = callGraph(lightShaderSource).get('fs_main')!;
    expect(calls.has('pointShadow')).toBe(true);
    expect(calls.has('shadow')).toBe(false);
  });

  it('the budget is the caller\'s: both loops of the march stop at `steps`, never at u.shadowSteps', () => {
    const march = body('shadow');
    expect(march).not.toMatch(/shadowSteps/);
    expect(march).toMatch(/while\s*\(\s*h\s*<=\s*0\.0\s*&&\s*i\s*<\s*steps\s*\)/);
    expect(march).toMatch(/for\s*\(\s*;\s*i\s*<\s*steps\s*;\s*i\+\+\s*\)/);
  });

  it('a march without fade is the arithmetic of before step 6: every select on `fading` keeps q (or 0.0) as its false operand', () => {
    // 1 - w*(1 - q) with w = 1 is not q in f32 (q = 0.1f gives 0.10000002f):
    // point and spot must take the select's false operand, never a blend.
    const march = body('shadow');
    expect(march).toMatch(/let\s+fading\s*=\s*fadeReach\s*>\s*0\.0\s*;/);
    const falseOperands = [...march.matchAll(/select\(\s*([^,]+?)\s*,[^;]*?,\s*fading\s*\)/g)].map((m) => m[1]);
    expect(falseOperands.sort()).toEqual(['0.0', 'q', 'q']);
    expect(march.match(/\bfading\b/g)).toHaveLength(4);  // the let and the three selects
    // Both q selects (the loop's and the out-of-steps one) still accumulate
    // into the running minimum, as before step 6. A plain `res = select(...)`
    // or a max keeps every false operand above and still changes the pixels.
    expect(march.match(/res\s*=\s*min\(\s*res\s*,\s*select\(\s*q\s*,/g)).toHaveLength(2);
  });

  it('sunFade: full strength without a reach; with one, a smoothstep over the last quarter', () => {
    expect(stripComments(lightShaderSource)).toMatch(/const\s+SUN_FADE_START\s*:\s*f32\s*=\s*0\.75\s*;/);
    const fade = body('sunFade');
    expect(fade).toMatch(/if\s*\(\s*reach\s*<=\s*0\.0\s*\)\s*\{\s*return\s+1\.0\s*;/);  // smoothstep never sees equal edges
    expect(fade).toMatch(/1\.0\s*-\s*smoothstep\(\s*SUN_FADE_START\s*\*\s*reach\s*,\s*reach\s*,\s*t\s*\)/);
  });

  it('spot and directional lights share one facing rule: lightFacing is the only reader of the world matrix column 0', () => {
    expect(stripComments(lightShaderSource).match(/\[0\]\.xy/g)).toHaveLength(1);
    const facing = body('lightFacing');
    expect(facing).toMatch(/\[0\]\.xy/);
    expect(facing).toMatch(/select\(\s*vec2f\(\s*1\.0\s*,\s*0\.0\s*\)\s*,\s*normalize\(\s*axis\s*\)\s*,\s*length\(\s*axis\s*\)\s*>\s*1e-6\s*\)/);
    expect(callGraph(lightShaderSource).get('fs_main')!.has('lightFacing')).toBe(true);
  });

  it('every binding an entry point reaches is visible to its stage: the SDF to vs_main too', () => {
    // A binding the vertex stage uses but the layout hides fails
    // createRenderPipeline; GPU validation then rejects the lit graph and
    // lighting silently stays off. No mock device sees it.
    LightAccumStage.SHADER_SOURCE = lightShaderSource;
    const { layouts } = setUp();
    const visibility = new Map([...layouts[0].entries].map((e) => [e.binding, e.visibility]));
    for (const [entry, stage] of [['vs_main', GPUShaderStage.VERTEX], ['fs_main', GPUShaderStage.FRAGMENT]] as const) {
      const reached = reachableFrom(lightShaderSource, entry);
      for (const b of bindingDecls(lightShaderSource).filter((d) => reached.has(d.name))) {
        expect((visibility.get(b.binding) ?? 0) & stage, `${entry} reaches ${b.name} (binding ${b.binding})`).not.toBe(0);
      }
    }
    expect(reachableFrom(lightShaderSource, 'vs_main').has('sdf')).toBe(true);  // not vacuous
  });

  it('a directional light carries its shadow ray to the fragment stage: flat, computed in vs_main (the same at every vertex of the light)', () => {
    expect(lightShaderSource).toMatch(/@location\(3\)\s*@interpolate\(flat\)\s*sunRay:\s*vec3f/);
    expect(body('vs_main')).toMatch(/if\s*\(\s*kind\s*==\s*DIRECTIONAL\s*\)\s*\{\s*out\.sunRay\s*=\s*directionalRay\(\s*e\s*\)\s*;/);
  });

  it('directionalRay: the facing TOWARD the light, projected as a vector (w = 0), y flipped like toScreenUV, 0.5 * size texels per NDC unit, normalised, range as the length, bounded without overflow', () => {
    const ray = body('directionalRay');
    expect(ray).toMatch(/vec4f\(\s*-lightFacing\(\s*transforms\[e\]\s*\)\s*,\s*0\.0\s*,\s*0\.0\s*\)/);
    // One world unit toward the light, in texels: NDC spans 2 across the
    // view and the texture `size` texels, hence 0.5 * size. Its length, the
    // texels per unit, normalises the direction and scales the range: without
    // the 0.5 every sun shadow is twice its range, with 0.25 half of it, and
    // headless only these lines see it (review wf_cf354af4-c53 [9]).
    expect(ray).toMatch(/let\s+perUnit\s*=\s*vec2f\(\s*clip\.x\s*,\s*-clip\.y\s*\)\s*\*\s*0\.5\s*\*\s*size\s*;/);
    expect(ray).toMatch(/let\s+texels\s*=\s*length\(\s*perUnit\s*\)\s*;/);
    expect(ray).toMatch(/return\s+vec3f\(\s*perUnit\s*\/\s*texels\s*,\s*reach\s*\)\s*;/);
    expect(ray).toMatch(/let\s+size\s*=\s*vec2f\(\s*textureDimensions\(\s*sdf\s*\)\s*\)\s*;/);
    // The PRODUCT range * texels stays finite, and is never computed first:
    // CameraAPI.zoom has no upper bound, so texels can be huge. It is the
    // whole reach, anchored at both ends: a `* 0.5` or `/ 2.0` after it would
    // make every sun shadow half its range (review of Task 9fix, Minor 1).
    expect(ray).toMatch(/let\s+reach\s*=\s*min\(\s*max\(\s*primParams\[e \* 8u \+ 3u\]\s*,\s*0\.0\s*\)\s*,\s*1e30\s*\/\s*texels\s*\)\s*\*\s*texels\s*;/);
    expect(reachableFrom(lightShaderSource, 'vs_main').has('lightFacing')).toBe(true);
  });

  it('a sun marches min(range, SDF exit): beyond the SDF counts as lit, never to infinity', () => {
    const sun = body('sunShadow');
    expect(sun).toMatch(/let\s+travel\s*=\s*min\(\s*ray\.z\s*,\s*exitDistance\(\s*origin\s*,\s*ray\.xy\s*,\s*fsize\s*\)\s*\)/);
    expect(sun).toMatch(/if\s*\(\s*travel\s*<\s*1\.0\s*\)\s*\{\s*return\s+1\.0\s*;/);
    const exit = body('exitDistance');
    expect(exit).toMatch(/select\(\s*vec2f\(\s*0\.0\s*\)\s*,\s*size\s*,\s*dir\s*>\s*vec2f\(\s*0\.0\s*\)\s*\)/);
    expect(exit).toMatch(/select\(\s*vec2f\(\s*1e30\s*\)/);
    // The exit itself, a slab test: on each axis a FORWARD distance
    // ((origin - side) would make every exit negative: no sun would ever
    // shadow), and the NEARER crossing (max, the entering/leaving mix-up,
    // would march on past the SDF, reading the clamped edge texels). Only an
    // axis the ray moves along divides, and by its own component:
    // select(f, t, cond) is easy to get backwards.
    expect(exit).toMatch(/\(\s*side\s*-\s*origin\s*\)\s*\/\s*select\(/);
    expect(exit).toMatch(/return\s+min\(\s*t\.x\s*,\s*t\.y\s*\)\s*;/);
    expect(exit).toMatch(/let\s+moving\s*=\s*abs\(\s*dir\s*\)\s*>\s*vec2f\(\s*1e-6\s*\)\s*;/);
    expect(exit).toMatch(/\/\s*select\(\s*vec2f\(\s*1\.0\s*\)\s*,\s*dir\s*,\s*moving\s*\)\s*,\s*moving\s*\)/);
  });

  it('a sun uses the fixed angle u.sourceFraction, not 1/k, fades over its range, and marches 4x the budget', () => {
    const sun = body('sunShadow');
    // Exact text: the angle A/B of docs/plans/assets/2026-09-30-step6-directional-bench.js
    // patches it (ANGLE_LINE). 4x: an axis-aligned sun's rays graze the faces
    // parallel to them for their whole length (sub-decision 2 (b)).
    expect(sun).toMatch(/return shadow\(origin, ray\.xy, travel, u\.sourceFraction, ray\.z, 4u \* u\.shadowSteps\);/);
    expect(sun).not.toMatch(/shadowHardness/);
  });

  it('the shadow gate: slot 7 is read once, through shadowedLightType, and a directional light marches with it', () => {
    const code = stripComments(lightShaderSource);
    expect(code.match(/primParams\[p \+ 7u\]/g)).toHaveLength(1);
    expect(code).toMatch(/let shadowStrength = select\(0\.0, clamp\(primParams\[p \+ 7u\], 0\.0, 1\.0\), shadowedLightType\(kind\)\);/);
    expect(body('fs_main')).toMatch(/else if \(kind == DIRECTIONAL && shadowStrength > 0\.0\) \{\s*intensity \*= mix\(1\.0, sunShadow\(in\.screenUV, in\.sunRay\), shadowStrength\);/);
  });

  it('LightUniform stays 80 bytes: step 6 adds no uniform', () => {
    expect(structSize(lightShaderSource, 'LightUniform')).toBe(80);
  });
});

describe('light-accum.wgsl: the light list and the blend modes (round step 7)', () => {
  it('vs_main takes its light from the list by instance index; nothing reads visibleIndices', () => {
    expect(body('vs_main')).toMatch(/let\s+e\s*=\s*lightOrder\[\s*instanceIdx\s*\]\s*;/);
    const code = stripComments(lightShaderSource);
    expect(code).not.toMatch(/\bvisibleIndices\b/);
    expect(code).toMatch(/@group\(0\)\s*@binding\(2\)\s*var<storage,\s*read>\s*lightOrder\s*:\s*array<u32>\s*;/);
    expect(bindingDecls(lightShaderSource).find((b) => b.binding === 2)?.name).toBe('lightOrder');
    expect(reachableFrom(lightShaderSource, 'fs_main').has('lightOrder')).toBe(false);  // vertex-only, like its layout entry
  });

  it('fs_main returns (c, 0) for add and sub, and (color·w, w) for mix, w its intensity clamped to [0, 1]', () => {
    const fs = body('fs_main');
    const returns = [...fs.matchAll(/return\s+([^;]+);/g)].map((m) => m[1].replace(/\s+/g, ''));
    expect(returns.sort()).toEqual(['vec4f(c,0.0)', 'vec4f(color*w,w)']);
    expect(fs).toMatch(/let\s+w\s*=\s*clamp\(\s*intensity\s*,\s*0\.0\s*,\s*1\.0\s*\)\s*;/);
    expect(fs).toMatch(/if\s*\(\s*blend\s*==\s*BLEND_MIX\s*\)\s*\{/);
    expect(fs).toMatch(/if\s*\(\s*blend\s*==\s*BLEND_SUB\s*\)\s*\{\s*c\s*=\s*-c\s*;/);
    // The add and sub arithmetic of before step 7: the over blend adds c whole.
    expect(fs).toMatch(/var\s+c\s*=\s*color\s*\*\s*intensity\s*;/);
    // The weight is the WHOLE intensity (decision 3: falloff × cone × shadow):
    // the mix branch comes after the last factor, never between two of them.
    expect(fs.indexOf('if (blend == BLEND_MIX)')).toBeGreaterThan(fs.lastIndexOf('intensity *='));
  });

  it('the blend field is read once, in fs_main, with the wire values of Rust and of the light list: a 3 blends like add', () => {
    const rust = readFileSync(new URL('../../../../crates/hyperion-core/src/components.rs', import.meta.url), 'utf8');
    const shift = Number(/pub const RENDER_META_LIGHT_BLEND_SHIFT: u32 = (\d+);/.exec(rust)?.[1]);
    const modes = new Map([.../pub enum LightBlendMode \{([^}]*)\}/.exec(rust)![1].matchAll(/(\w+)\s*=\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
    const code = stripComments(lightShaderSource);
    const ids = new Map([...code.matchAll(/const\s+([A-Z_]+)\s*:\s*u32\s*=\s*(\d+)u\s*;/g)].map((m) => [m[1], Number(m[2])]));
    expect(shift).toBe(14);
    expect(ids.get('LIGHT_BLEND_SHIFT')).toBe(shift);
    expect(ids.get('BLEND_SUB')).toBe(modes.get('Sub'));
    expect(ids.get('BLEND_MIX')).toBe(modes.get('Mix'));
    // The CPU list draws exactly what the shader mixes after everything else.
    expect(ids.get('BLEND_MIX')).toBe(BLEND_MIX);
    expect(code.match(/>>\s*LIGHT_BLEND_SHIFT/g)).toHaveLength(1);
    expect(body('fs_main')).toMatch(/let\s+blend\s*=\s*\(\s*renderMeta\[e \* 2u \+ 1u\]\s*>>\s*LIGHT_BLEND_SHIFT\s*\)\s*&\s*3u\s*;/);
    // Equality only: `>= BLEND_MIX` would mix a 3 that the list sorts with add.
    expect(code).not.toMatch(/[<>]=?\s*BLEND_(?:MIX|SUB)\b/);
  });

  it('the header no longer says mix is added like add', () => {
    // At HEAD the phrase breaks across two comment lines: "(added" / "// like `add`)".
    expect(lightShaderSource.slice(0, lightShaderSource.indexOf('struct LightUniform'))).not.toMatch(/added\s+(?:\/\/\s*)?like\s+`?add/);
    expect(lightShaderSource).toMatch(/Not yet: the `sprite` light type \(discarded\)\./);
  });
});
