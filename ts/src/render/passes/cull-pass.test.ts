import { describe, it, expect, vi } from 'vitest';
import { CullPass, computeWorkgroupSize, prepareShaderSource, NUM_PRIM_TYPES, BUCKETS_PER_TYPE, BLEND_MODES, OPAQUE_DRAW_BUCKETS, TOTAL_DRAW_BUCKETS, TRANSPARENT_BUCKET_OFFSET, extractTransparentFlag, extractPrimType } from './cull-pass';
import cullShaderSource from '../../shaders/cull.wgsl?raw';
import { ResourcePool } from '../resource-pool';
import type { FrameState } from '../render-pass';
import { MAX_GPU_ENTITIES } from '../../types';

describe('CullPass', () => {
  it('should implement RenderPass interface', () => {
    const pass = new CullPass();
    expect(pass.name).toBe('cull');
    expect(pass.reads).toContain('entity-bounds');
    // Culling needs only the bounding sphere. Declaring the transforms as read
    // would be harmless for ordering, but it would invite binding them again.
    expect(pass.reads).not.toContain('entity-transforms');
    expect(pass.writes).toContain('visible-indices');
    expect(pass.writes).toContain('indirect-args');
    expect(pass.optional).toBe(false);
  });

  it('should declare render-meta as a read dependency', () => {
    const pass = new CullPass();
    expect(pass.reads).toContain('render-meta');
  });

  it('should declare tex-indices as a read dependency for 2-bucket sort', () => {
    const pass = new CullPass();
    expect(pass.reads).toContain('tex-indices');
  });
});

describe('opaque/transparent split constants', () => {
  it('has 2 buckets per primitive type (tier0 vs other)', () => {
    expect(BUCKETS_PER_TYPE).toBe(2);
  });

  it('has 2 blend modes (opaque and transparent)', () => {
    expect(BLEND_MODES).toBe(2);
  });

  it('has 7 primitive types (Phase 17 added Light2D = 6)', () => {
    expect(NUM_PRIM_TYPES).toBe(7);
  });

  it('has 14 opaque draw buckets (7 prim types x 2 buckets)', () => {
    expect(OPAQUE_DRAW_BUCKETS).toBe(14);
  });

  it('has 28 total draw buckets (14 opaque + 14 transparent)', () => {
    expect(TOTAL_DRAW_BUCKETS).toBe(28);
  });

  it('transparent bucket offset starts at 14', () => {
    expect(TRANSPARENT_BUCKET_OFFSET).toBe(14);
  });

  it('produces 560-byte indirect args buffer (28 x 5 u32 x 4 bytes)', () => {
    expect(TOTAL_DRAW_BUCKETS * 5 * 4).toBe(560);
  });
});

// ⚠️ `cull.wgsl` declares NUM_PRIM_TYPES independently of `cull-pass.ts`, and
// WebGPU cannot be exercised headless — so nothing at runtime would notice the
// two drifting apart until a draw call read past the end of the indirect
// buffer. These assertions read the shader source as text, which is the only
// check available without a browser. Check #4 of the `wgsl-validator` agent.
describe('cull.wgsl agrees with cull-pass.ts on the bucket count', () => {
  function wgslConst(name: string): number {
    const m = cullShaderSource.match(new RegExp(`const\\s+${name}\\s*:\\s*u32\\s*=\\s*(\\d+)u`));
    if (!m) throw new Error(`cull.wgsl no longer declares a literal '${name}'`);
    return Number(m[1]);
  }

  it('declares the same NUM_PRIM_TYPES', () => {
    expect(wgslConst('NUM_PRIM_TYPES')).toBe(NUM_PRIM_TYPES);
  });

  it('declares the same BUCKETS_PER_TYPE', () => {
    expect(wgslConst('BUCKETS_PER_TYPE')).toBe(BUCKETS_PER_TYPE);
  });

  it('sizes drawArgs and workgroup storage by const-expression, not by literal', () => {
    // Deriving them is what makes NUM_PRIM_TYPES the single number to change.
    // A literal creeping back in is the regression this guards.
    expect(cullShaderSource).toContain('array<DrawIndirectArgs, TOTAL_BUCKETS>');
    expect(cullShaderSource).toContain('array<u32, TOTAL_BUCKETS * MAX_SUBGROUPS>');
    expect(cullShaderSource).toContain('array<u32, TOTAL_BUCKETS>');
  });

  it('keeps workgroup storage inside the 16 KiB limit', () => {
    const MAX_SUBGROUPS = 8;
    const bytes = (TOTAL_DRAW_BUCKETS * MAX_SUBGROUPS * 2 + TOTAL_DRAW_BUCKETS) * 4;
    expect(bytes).toBeLessThan(16 * 1024);
  });
});

describe('transparent flag extraction', () => {
  it('extractTransparentFlag reads bit 8 from renderMeta', () => {
    const meta = (5 << 0) | (1 << 8); // primType=5, transparent=true
    expect(extractTransparentFlag(meta)).toBe(true);
    expect(extractPrimType(meta)).toBe(5);
  });

  it('non-transparent entity has bit 8 = 0', () => {
    const meta = 3; // primType=3, transparent=false
    expect(extractTransparentFlag(meta)).toBe(false);
    expect(extractPrimType(meta)).toBe(3);
  });

  it('transparent entities route to correct bucket offset', () => {
    // For a transparent entity with primType=2, bucket=1:
    // argSlot = TRANSPARENT_BUCKET_OFFSET + 2 * BUCKETS_PER_TYPE + 1 = 14 + 4 + 1 = 19
    const primType = 2;
    const bucket = 1;
    const argSlot = TRANSPARENT_BUCKET_OFFSET + primType * BUCKETS_PER_TYPE + bucket;
    expect(argSlot).toBe(19);
  });

  it('Light2D (type 6) claims the last opaque bucket pair', () => {
    // Its transparent pair exists too and stays empty — see TOTAL_DRAW_BUCKETS.
    expect(6 * BUCKETS_PER_TYPE + 0).toBe(12);
    expect(6 * BUCKETS_PER_TYPE + 1).toBe(13);
    expect(TRANSPARENT_BUCKET_OFFSET + 6 * BUCKETS_PER_TYPE + 1).toBe(27);
    // Every bucket index stays inside the buffer.
    expect(TRANSPARENT_BUCKET_OFFSET + 6 * BUCKETS_PER_TYPE + 1).toBeLessThan(TOTAL_DRAW_BUCKETS);
  });

  it('opaque entities route to correct bucket offset', () => {
    // For an opaque entity with primType=2, bucket=1:
    // argSlot = 0 + 2 * 2 + 1 = 5
    const primType = 2;
    const bucket = 1;
    const argSlot = primType * BUCKETS_PER_TYPE + bucket;
    expect(argSlot).toBe(5);
  });
});

describe('computeWorkgroupSize', () => {
  it('returns 256 when subgroups not used', () => {
    expect(computeWorkgroupSize(false, 32)).toBe(256);
  });
  it('returns 64 for subgroupSize=8 (Intel iGPU)', () => {
    expect(computeWorkgroupSize(true, 8)).toBe(64);
  });
  it('returns 256 for subgroupSize=32 (NVIDIA/Apple)', () => {
    expect(computeWorkgroupSize(true, 32)).toBe(256);
  });
  it('returns 256 for subgroupSize=64 (AMD)', () => {
    expect(computeWorkgroupSize(true, 64)).toBe(256);
  });
});

describe('prepareShaderSource', () => {
  it('returns unchanged source when subgroups not used', () => {
    const src = 'override USE_SUBGROUPS: bool = false;';
    expect(prepareShaderSource(src, false)).toBe(src);
  });
  it('prepends enable subgroups when used', () => {
    const src = 'override USE_SUBGROUPS: bool = false;';
    const result = prepareShaderSource(src, true);
    expect(result).toBe('enable subgroups;\n' + src);
  });
});

describe('prepareShaderSource v2 (3-level)', () => {
  it('returns unchanged source for no subgroups', () => {
    const src = 'override USE_SUBGROUPS: bool = false;';
    expect(prepareShaderSource(src, false, false)).toBe(src);
  });

  it('prepends enable subgroups when subgroups used but no subgroup_id', () => {
    const src = 'override USE_SUBGROUPS: bool = false;';
    const result = prepareShaderSource(src, true, false);
    expect(result).toBe('enable subgroups;\n' + src);
  });

  it('prepends enable subgroups + requires subgroup_id when both available', () => {
    const src = 'override USE_SUBGROUPS: bool = false;';
    const result = prepareShaderSource(src, true, true);
    expect(result).toBe('enable subgroups;\nrequires subgroup_id;\n' + src);
  });

  it('ignores subgroup_id when subgroups not supported', () => {
    const src = 'fn main() {}';
    expect(prepareShaderSource(src, false, true)).toBe(src);
  });
});

// The engine ran for four phases believing `override USE_SUBGROUPS = false` was
// enough to make the subgroup branch harmless on a device without the feature.
// It is not: WGSL validates every builtin call in the module no matter what an
// override is set to, so `subgroupAdd` in the text is a hard compile error
// there — and `createRenderer` swallows it into a null renderer, so the symptom
// was a blank canvas, not a message. That covers all of Firefox and Safari.
//
// Verified against a real driver via chrome-devtools `getCompilationInfo()`
// (the method in CLAUDE.md); these tests are the cheap standing guard.
describe('prepareShaderSource strips subgroup-only code from the real shader', () => {
  const SUBGROUP_BUILTIN = /subgroup(Add|Elect|ExclusiveAdd|BroadcastFirst)\s*\(/;

  it('the shader really does call subgroup builtins — otherwise this is all moot', () => {
    expect(cullShaderSource).toMatch(SUBGROUP_BUILTIN);
  });

  it('carries both region markers, in order', () => {
    const begin = cullShaderSource.indexOf('// BEGIN-SUBGROUPS-ONLY');
    const end = cullShaderSource.indexOf('// END-SUBGROUPS-ONLY');
    expect(begin, 'BEGIN-SUBGROUPS-ONLY marker missing').toBeGreaterThan(-1);
    expect(end, 'END-SUBGROUPS-ONLY marker missing').toBeGreaterThan(begin);
  });

  it('leaves no subgroup builtin behind when the feature is absent', () => {
    const stripped = prepareShaderSource(cullShaderSource, false);
    expect(stripped).not.toMatch(SUBGROUP_BUILTIN);
    expect(stripped.length).toBeLessThan(cullShaderSource.length);
  });

  it('keeps the atomic fallback that the stripped shader has to run', () => {
    const stripped = prepareShaderSource(cullShaderSource, false);
    expect(stripped).toContain('atomicAdd(&drawArgs[argSlot].instanceCount, 1u)');
    // Braces still balance, i.e. the region was removed as a whole block.
    const open = (stripped.match(/\{/g) ?? []).length;
    const close = (stripped.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
  });

  it('leaves the subgroup path untouched when the feature is present', () => {
    const enabled = prepareShaderSource(cullShaderSource, true);
    expect(enabled).toMatch(SUBGROUP_BUILTIN);
    expect(enabled).toBe('enable subgroups;\n' + cullShaderSource);
  });

  it('never emits the enable directive on the stripped path', () => {
    // Doing so would fail validation on exactly the devices this path targets.
    // Checked at the start of the source, not anywhere in it: the shader's own
    // header comment names the directive while explaining why it is not there.
    expect(prepareShaderSource(cullShaderSource, false).startsWith('enable ')).toBe(false);
    expect(prepareShaderSource(cullShaderSource, false, true).startsWith('enable ')).toBe(false);
    expect(prepareShaderSource(cullShaderSource, true).startsWith('enable subgroups;\n')).toBe(true);
  });
});

// ── Storage-buffer budget ──────────────────────────────────────────
//
// `maxStorageBuffersPerShaderStage` defaults to 8, and `requestDevice` asks for
// no higher limit. The limit is counted on the bind group LAYOUT entries, not on
// what the shader reads. Going over it does not throw: the pipeline comes back
// invalid and the GPU reports the error asynchronously. `cull.wgsl` sat at 9
// from 4ea6cb5 (temporal culling) until the dead `transforms` binding went away,
// and in that time no cull pipeline ever ran. Since b4db737 every graph rebuild
// was also rejected, because each graph contains a CullPass. These tests are the
// headless half of that check; the other half is an error scope on a real
// device, which no test can reach.
const SPEC_MIN_STORAGE_BUFFERS_PER_STAGE = 8;

/** Names of every `var<storage, ...>` the shader declares. */
function storageVarNames(wgsl: string): string[] {
  return [...wgsl.matchAll(/var<storage[^>]*>\s+(\w+)\s*:/g)].map((m) => m[1]);
}

function withoutComments(wgsl: string): string {
  return wgsl.replace(/\/\/[^\n]*/g, '');
}

/** A fake device that records what `CullPass` asks of it. */
function makeCullDevice() {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080, INDIRECT: 0x0100 };
  g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

  const calls = {
    pipelineLayouts: [] as GPUBindGroupLayoutDescriptor[][],
    writeBuffer: [] as GPUBuffer[],
    createBindGroup: 0,
  };
  const buffer = () => ({ destroy() {} });
  const device = {
    createShaderModule: () => ({}),
    createBuffer: buffer,
    createBindGroupLayout: (desc: GPUBindGroupLayoutDescriptor) => ({ desc }),
    createPipelineLayout: (desc: { bindGroupLayouts: Array<{ desc: GPUBindGroupLayoutDescriptor }> }) => {
      calls.pipelineLayouts.push(desc.bindGroupLayouts.map((l) => l.desc));
      return {};
    },
    createComputePipeline: () => ({}),
    createBindGroup: () => { calls.createBindGroup++; return {}; },
    queue: { writeBuffer: (target: GPUBuffer) => { calls.writeBuffer.push(target); } },
  } as unknown as GPUDevice;
  return { device, calls };
}

/** Runs `CullPass.setup()` on the real shader against a recording device. */
function setUpCullPass() {
  const { device, calls } = makeCullDevice();
  const resources = { getBuffer: () => ({ destroy() {} }) } as unknown as ResourcePool;
  const saved = CullPass.SHADER_SOURCE;
  CullPass.SHADER_SOURCE = cullShaderSource;
  const pass = new CullPass();
  try {
    pass.setup(device, resources);
  } finally {
    CullPass.SHADER_SOURCE = saved;
  }
  return { pass, device, calls };
}

/** The layouts `CullPass.setup()` hands to the device. */
function recordCullSetup(): GPUBindGroupLayoutDescriptor[][] {
  return setUpCullPass().calls.pipelineLayouts;
}

function storageEntryCount(layouts: GPUBindGroupLayoutDescriptor[]): number {
  return layouts
    .flatMap((l) => [...l.entries])
    .filter((e) => e.buffer?.type === 'storage' || e.buffer?.type === 'read-only-storage')
    .length;
}

describe('cull pipeline storage-buffer budget', () => {
  it('declares no more storage buffers than the spec guarantees per stage', () => {
    expect(storageVarNames(cullShaderSource).length).toBeLessThanOrEqual(SPEC_MIN_STORAGE_BUFFERS_PER_STAGE);
  });

  it('reads every storage buffer it declares — a dead binding still counts against the limit', () => {
    const code = withoutComments(cullShaderSource);
    const unread = storageVarNames(cullShaderSource).filter(
      (name) => (code.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length < 2,
    );
    expect(unread).toEqual([]);
  });

  it('hands the device a pipeline layout within the same budget', () => {
    const [layouts] = recordCullSetup();
    expect(storageEntryCount(layouts)).toBeLessThanOrEqual(SPEC_MIN_STORAGE_BUFFERS_PER_STAGE);
  });

  it('gives every binding the shader declares a layout entry of the same buffer type', () => {
    // A wrong type (`read` vs `read_write`) is a pipeline validation error at
    // runtime, so the renumbering these layouts go through must keep them paired.
    const WGSL_TO_LAYOUT: Record<string, GPUBufferBindingType> = {
      'uniform': 'uniform',
      'storage, read': 'read-only-storage',
      'storage, read_write': 'storage',
    };
    const [layouts] = recordCullSetup();
    const declared = [...cullShaderSource.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var<([^>]+)>/g)]
      .map((m) => ({ group: Number(m[1]), binding: Number(m[2]), type: WGSL_TO_LAYOUT[m[3].trim()] }));
    expect(declared.length).toBeGreaterThan(0);
    for (const { group, binding, type } of declared) {
      const entry = [...(layouts[group]?.entries ?? [])].find((e) => e.binding === binding);
      expect(entry?.buffer?.type, `@group(${group}) @binding(${binding})`).toBe(type);
    }
    const layoutEntries = layouts.reduce((n, l) => n + [...l.entries].length, 0);
    expect(layoutEntries, 'layout entries with no binding in the shader').toBe(declared.length);
  });
});

// Temporal culling (4ea6cb5) let an entity visible last frame and not dirty skip
// the frustum test. It never ran on a GPU: its extra bind group pushed the
// pipeline to 9 storage buffers. Measured once it could run, the skip saved
// 0 us at 100k and 1M entities, while costing CPU uploads every frame. Its rule
// was also wrong. Camera motion never invalidated it, and dirty bits reached
// the GPU only in Mode C. Anything seen once stayed "visible" until the next
// graph rebuild. See docs/plans/2026-09-26-cull-temporal-firstinstance-brief.md.
describe('culling keeps no state across frames', () => {
  it('decides visibility from the frustum test alone', () => {
    const code = withoutComments(cullShaderSource);
    expect(code).not.toMatch(/@group\(1\)/);
    expect(code).not.toMatch(/visibility_prev|visibility_out|dirty_bits|invalidate/);
  });

  it('builds a pipeline with a single bind group', () => {
    expect(recordCullSetup()[0]).toHaveLength(1);
  });

  it('writes only the cull uniform and the indirect-args reset per frame, and builds no bind group', () => {
    const { pass, device, calls } = setUpCullPass();
    const writesAtSetup = calls.writeBuffer.length;
    const bindGroupsAtSetup = calls.createBindGroup;
    const frame = {
      entityCount: 1000,
      cameraViewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    } as unknown as FrameState;

    pass.prepare(device, frame);
    pass.prepare(device, frame);

    expect(calls.writeBuffer.length - writesAtSetup).toBe(4);
    expect(calls.createBindGroup - bindGroupsAtSetup).toBe(0);
  });
});

describe('CullPass with an empty world', () => {
  it('dispatches nothing (0 workgroups is a WebGPU warning); the reset args already draw nothing', () => {
    const pass = new CullPass();
    Object.assign(pass as unknown as Record<string, unknown>, { pipeline: {}, bindGroup0: {} });
    const beginComputePass = vi.fn(() => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups: vi.fn(), end() {} }));
    const encoder = { beginComputePass } as unknown as GPUCommandEncoder;
    pass.execute(encoder, { entityCount: 0 } as FrameState, new ResourcePool());
    expect(beginComputePass).not.toHaveBeenCalled();
    pass.execute(encoder, { entityCount: 3 } as FrameState, new ResourcePool());
    expect(beginComputePass).toHaveBeenCalledTimes(1);
  });
});

describe('CullPass sizes its regions with MAX_GPU_ENTITIES', () => {
  it('writes it as maxEntitiesPerType and as the stride of every firstInstance', () => {
    const pass = new CullPass();
    const uniform = { label: 'cull-uniform' };
    const indirect = { label: 'indirect-args' };
    Object.assign(pass as unknown as Record<string, unknown>, { cullUniformBuffer: uniform, indirectBuffer: indirect });
    const writes = new Map<unknown, ArrayBuffer | Uint32Array>();
    const device = {
      queue: { writeBuffer: (target: unknown, _offset: number, data: ArrayBuffer | Uint32Array) => { writes.set(target, data); } },
    } as unknown as GPUDevice;
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    pass.prepare(device, { entityCount: 5, cameraViewProjection: identity } as unknown as FrameState);

    expect(new Uint32Array(writes.get(uniform) as ArrayBuffer, 96, 4)[1]).toBe(MAX_GPU_ENTITIES);
    const args = writes.get(indirect) as Uint32Array;
    for (let i = 0; i < TOTAL_DRAW_BUCKETS; i++) {
      expect(args[i * 5 + 4], `bucket ${i}`).toBe(i * MAX_GPU_ENTITIES);
    }
  });
});
