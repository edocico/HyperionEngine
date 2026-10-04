import { describe, it, expect, beforeAll } from 'vitest';
import { LightAccumStage, LIGHT2D_ARG_SLOTS, SLICE } from './light-accum-stage';
import { ResourcePool } from '../resource-pool';
import { SCENE_HDR_FORMAT } from '../formats';
import { BUCKETS_PER_TYPE, TRANSPARENT_BUCKET_OFFSET } from './cull-pass';
import type { FrameState } from '../render-pass';
import lightShaderSource from '../../shaders/light-accum.wgsl?raw';
import { bindingDecls, callGraph, functionBody, functionParams, reachableFrom, stripComments } from '../../shaders/wgsl-analysis';
import { structSize } from '../../shaders/uniform-layout';

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
  const layouts: GPUBindGroupLayoutDescriptor[] = [];
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => {
      const b = { size: d.size, usage: d.usage, destroyed: false, destroy() { b.destroyed = true; } };
      buffers.push(b);
      return b;
    },
    createShaderModule: () => ({}),
    createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => { layouts.push(d); return {}; },
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
  return { stage, device, pipelines, buffers, bindGroups, writes, layouts, frame, uniform, encode };
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

  // Review 2026-09-26: `.transparent()` is only a blend flag, but CullPass
  // files a light that has it under the transparent buckets (26-27), which
  // this stage never drew, so the light lit nothing while the grouping counted
  // it. Lights are additive: both blend modes draw the same.
  it('clears its target to the ambient light and draws the Light2D buckets of both blend modes', () => {
    const { stage, device, frame, encode } = setUp();
    stage.prepare(device, frame(), groups3);
    const target = view('layer0');
    const pass = encode(0, target, view('sdf'), frame({ ambient: [0.2, 0.4, 0.6, 0.5] }));
    const attachment = [...pass.desc.colorAttachments][0]!;
    expect(attachment.view).toBe(target);
    expect(attachment.loadOp).toBe('clear');
    expect(attachment.clearValue).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    expect(LIGHT2D_ARG_SLOTS).toEqual([12, 13, 26, 27]);
    expect(pass.draws).toEqual([240, 260, 520, 540]);
  });

  it('draws every slot CullPass can file a Light2D under, and only those', () => {
    // cull.wgsl: argSlot = blendOffset + primType * BUCKETS_PER_TYPE + bucket,
    // bucket 1 for a tier > 0 texture, blendOffset 14 for bit 8.
    const reachable = new Set<number>();
    for (const transparent of [false, true]) {
      for (const texturedTier of [false, true]) {
        reachable.add((transparent ? TRANSPARENT_BUCKET_OFFSET : 0) + 6 * BUCKETS_PER_TYPE + (texturedTier ? 1 : 0));
      }
    }
    expect(new Set(LIGHT2D_ARG_SLOTS)).toEqual(reachable);
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

  it('the march is shared: shadow(origin, dir, travel, angle, fadeReach), and pointShadow hands it no fade', () => {
    expect(functionParams(lightShaderSource, 'shadow')).toEqual(['origin', 'dir', 'travel', 'angle', 'fadeReach']);
    expect(body('pointShadow')).toMatch(/return\s+shadow\(\s*origin\s*,\s*dir\s*,\s*travel\s*,\s*angle\s*,\s*0\.0\s*\)/);
    const calls = callGraph(lightShaderSource).get('fs_main')!;
    expect(calls.has('pointShadow')).toBe(true);
    expect(calls.has('shadow')).toBe(false);
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

  it('a directional light carries its shadow ray to the fragment stage: flat, computed once per light in vs_main', () => {
    expect(lightShaderSource).toMatch(/@location\(3\)\s*@interpolate\(flat\)\s*sunRay:\s*vec3f/);
    expect(body('vs_main')).toMatch(/if\s*\(\s*kind\s*==\s*DIRECTIONAL\s*\)\s*\{\s*out\.sunRay\s*=\s*directionalRay\(\s*e\s*\)\s*;/);
  });

  it('directionalRay: the facing TOWARD the light, projected as a vector (w = 0), y flipped like toScreenUV, range as the length, bounded without overflow', () => {
    const ray = body('directionalRay');
    expect(ray).toMatch(/vec4f\(\s*-lightFacing\(\s*transforms\[e\]\s*\)\s*,\s*0\.0\s*,\s*0\.0\s*\)/);
    expect(ray).toMatch(/vec2f\(\s*clip\.x\s*,\s*-clip\.y\s*\)/);
    expect(ray).toMatch(/textureDimensions\(\s*sdf\s*\)/);
    // The PRODUCT range * texels stays finite, and is never computed first:
    // CameraAPI.zoom has no upper bound, so texels can be huge.
    expect(ray).toMatch(/min\(\s*max\(\s*primParams\[e \* 8u \+ 3u\]\s*,\s*0\.0\s*\)\s*,\s*1e30\s*\/\s*texels\s*\)\s*\*\s*texels/);
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

  it('a sun uses the fixed angle u.sourceFraction, not 1/k, and fades over its range', () => {
    const sun = body('sunShadow');
    // Exact text: the angle A/B of docs/plans/assets/2026-09-30-step6-directional-bench.js patches it.
    expect(sun).toMatch(/return shadow\(origin, ray\.xy, travel, u\.sourceFraction, ray\.z\);/);
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
