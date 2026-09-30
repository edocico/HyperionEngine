import { describe, it, expect } from 'vitest';
import { FrameRecorder, instrumentEncoder, drawDoesWork, dispatchDoesWork } from './timestamp-intercept';

const querySet = { label: 'qs' } as unknown as GPUQuerySet;
type Desc = Record<string, unknown> | undefined;

/**
 * A command encoder whose methods live on its prototype, like the real
 * GPUCommandEncoder, so the tests can tell an own-property override from a
 * patched prototype. Its "native" methods record the descriptor they get and
 * return a pass encoder that logs every call.
 */
class FakeEncoder {
  readonly received: Desc[] = [];
  readonly calls: string[] = [];

  beginRenderPass(desc: GPURenderPassDescriptor): GPURenderPassEncoder {
    this.received.push(desc as unknown as Desc);
    return this.passEncoder() as unknown as GPURenderPassEncoder;
  }

  beginComputePass(desc?: GPUComputePassDescriptor): GPUComputePassEncoder {
    this.received.push(desc as unknown as Desc);
    return this.passEncoder() as unknown as GPUComputePassEncoder;
  }

  private passEncoder() {
    const log = (name: string) => (...args: unknown[]) => {
      this.calls.push(`${name}(${args.map((a) => (Array.isArray(a) ? `[${a.length}]` : String(a))).join(',')})`);
    };
    return {
      draw: log('draw'),
      drawIndexed: log('drawIndexed'),
      drawIndirect: log('drawIndirect'),
      drawIndexedIndirect: log('drawIndexedIndirect'),
      executeBundles: log('executeBundles'),
      dispatchWorkgroups: log('dispatchWorkgroups'),
      dispatchWorkgroupsIndirect: log('dispatchWorkgroupsIndirect'),
      end: log('end'),
    };
  }
}

function setUp(maxPairs = 8) {
  const fake = new FakeEncoder();
  const encoder = fake as unknown as GPUCommandEncoder;
  const recorder = new FrameRecorder(querySet, maxPairs);
  instrumentEncoder(encoder, recorder);
  return { fake, encoder, recorder };
}

const colour = () => ({ colorAttachments: [] }) as unknown as GPURenderPassDescriptor;
const own = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

describe('instrumentEncoder', () => {
  it('overrides begin*Pass as own properties of this encoder, never of its prototype or of another encoder', () => {
    // Captured BEFORE instrumenting: reading the prototype slot afterwards
    // would compare it with itself, and a write onto it would go unseen.
    const protoRender = FakeEncoder.prototype.beginRenderPass;
    const protoCompute = FakeEncoder.prototype.beginComputePass;
    const { fake } = setUp();
    expect(own(fake, 'beginRenderPass')).toBe(true);
    expect(own(fake, 'beginComputePass')).toBe(true);
    expect(FakeEncoder.prototype.beginRenderPass).toBe(protoRender);
    expect(FakeEncoder.prototype.beginComputePass).toBe(protoCompute);
    const other = new FakeEncoder();
    expect(own(other, 'beginRenderPass')).toBe(false);
    expect(own(other, 'beginComputePass')).toBe(false);
    expect(other.beginRenderPass).toBe(protoRender);
    expect(other.beginComputePass).toBe(protoCompute);
  });

  it('gives each timed pass the next pair, through a descriptor derived from the original', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('cull', true);
    encoder.beginComputePass({ label: 'cull' });
    recorder.enterNode('forward', true);
    const original = { label: 'forward', colorAttachments: [] } as unknown as GPURenderPassDescriptor;
    encoder.beginRenderPass(original);
    expect(fake.received.map((d) => d?.timestampWrites)).toEqual([
      { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
      { querySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 },
    ]);
    expect(recorder.pairs.map((p) => p.name)).toEqual(['cull', 'forward']);
    // The original is never written; its members are read from the original.
    expect(own(original, 'timestampWrites')).toBe(false);
    expect(fake.received[1]?.label).toBe('forward');
    expect(fake.received[1]?.colorAttachments).toBe(original.colorAttachments);
  });

  it('a compute pass opened with no descriptor receives one that carries only the pair', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('scatter', true);
    encoder.beginComputePass();
    expect(fake.received[0]?.timestampWrites).toEqual({ querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
    // Only the pair: there is no original to read anything else from.
    expect(fake.received[0]?.label).toBeUndefined();
  });

  it('a compute pass opened with no descriptor outside a timed node receives none: the call is forwarded untouched', () => {
    const { encoder, fake, recorder } = setUp();
    encoder.beginComputePass();
    recorder.enterNode('overlay', false);
    encoder.beginComputePass();
    expect(fake.received).toEqual([undefined, undefined]);
    expect(recorder.pairs).toEqual([]);
  });

  it('a class descriptor with a #private getter keeps its receiver: the browser reads its members from the original', () => {
    class OverlayDesc {
      #att = [] as unknown[];
      get colorAttachments() { return this.#att; }
    }
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('overlay', true);
    const original = new OverlayDesc() as unknown as GPURenderPassDescriptor;
    encoder.beginRenderPass(original);
    const got = fake.received[0] as object;
    // WebIDL reads each dictionary member with [[Get]] on the object it receives.
    expect(() => Reflect.get(got, 'colorAttachments', got)).not.toThrow();
    expect(Reflect.get(got, 'colorAttachments', got)).toBe(original.colorAttachments);
    expect(Reflect.get(got, 'timestampWrites', got)).toEqual({ querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
    expect(own(original, 'timestampWrites')).toBe(false);
  });

  it('a compute descriptor whose getter reads a #private field keeps its receiver too', () => {
    class Desc {
      #l = 'x';
      get label() { return this.#l; }
    }
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('overlay', true);
    encoder.beginComputePass(new Desc() as unknown as GPUComputePassDescriptor);
    const got = fake.received[0] as object;
    expect(Reflect.get(got, 'label', got)).toBe('x');
    expect(Reflect.get(got, 'timestampWrites', got)).toEqual({ querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
  });

  it('a null descriptor is an empty dictionary: it does not throw, and the pass is timed', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('plugin', true);
    expect(() => encoder.beginComputePass(null as never)).not.toThrow();
    expect(recorder.pairs.map((p) => p.name)).toEqual(['plugin']);
    const got = fake.received[0] as object;
    expect(Reflect.get(got, 'timestampWrites', got)).toEqual({ querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
  });

  it('a frozen descriptor with an own timestampWrites: undefined is timed, and stays frozen and unchanged', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('overlay', true);
    const original = Object.freeze({
      label: 'frozen', timestampWrites: undefined, colorAttachments: [],
    }) as unknown as GPURenderPassDescriptor;
    encoder.beginRenderPass(original);
    const got = fake.received[0] as object;
    expect(recorder.pairs).toHaveLength(1);
    // A Proxy whose target were the frozen original would throw here: the get
    // invariant of a read-only, non-configurable own property.
    expect(Reflect.get(got, 'timestampWrites', got)).toEqual({ querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
    expect(Reflect.get(got, 'label', got)).toBe('frozen');
    expect(Reflect.get(got, 'colorAttachments', got)).toBe(original.colorAttachments);
    expect(Object.isFrozen(original)).toBe(true);
    expect(original.timestampWrites).toBeUndefined();
  });

  it('a descriptor with timestampWrites of its own passes through untouched and is not timed', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('plugin', true);
    const mine = { timestampWrites: { querySet: {} as GPUQuerySet, beginningOfPassWriteIndex: 5 } };
    encoder.beginComputePass(mine as GPUComputePassDescriptor);
    expect(fake.received[0]).toBe(mine);
    expect(recorder.pairs).toEqual([]);
  });

  it('one descriptor object reused for two passes gets two pairs and is never written', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('bloom', true);
    const shared = colour();
    encoder.beginRenderPass(shared);
    encoder.beginRenderPass(shared);
    expect(fake.received.map((d) => (d?.timestampWrites as { beginningOfPassWriteIndex: number }).beginningOfPassWriteIndex)).toEqual([0, 2]);
    expect(own(shared, 'timestampWrites')).toBe(false);
  });

  it('a pass opened through the prototype method is not timed and leaves the other pairs in place', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('a', true);
    encoder.beginComputePass({});
    FakeEncoder.prototype.beginComputePass.call(fake, { label: 'bypass' });
    encoder.beginComputePass({});
    expect(recorder.pairs).toHaveLength(2);
    expect(fake.received[1]).toEqual({ label: 'bypass' });
    expect(fake.received[2]?.timestampWrites).toMatchObject({ beginningOfPassWriteIndex: 2 });
  });

  it('a pass encoder that lacks a work method is instrumented without it: nothing is invented, the others still mark work', () => {
    const noop = () => {};
    const renderPass = { draw: noop, drawIndexed: noop, drawIndirect: noop, drawIndexedIndirect: noop, end: noop };
    const computePass = { dispatchWorkgroups: noop, end: noop };
    const encoder = {
      beginRenderPass: () => renderPass,
      beginComputePass: () => computePass,
    } as unknown as GPUCommandEncoder;
    const recorder = new FrameRecorder(querySet, 8);
    instrumentEncoder(encoder, recorder);
    recorder.enterNode('n', true);
    let render!: GPURenderPassEncoder;
    let compute!: GPUComputePassEncoder;
    expect(() => {
      render = encoder.beginRenderPass(colour());
      compute = encoder.beginComputePass({});
    }).not.toThrow();
    // wrap() skipped the absent methods: a wrapper installed for one would
    // make the pass encoder answer to a command it never had.
    expect('executeBundles' in render).toBe(false);
    expect('dispatchWorkgroupsIndirect' in compute).toBe(false);
    render.draw(3);
    compute.dispatchWorkgroups(1);
    expect(recorder.pairs.map((p) => p.work)).toEqual([true, true]);
  });

  it('forwards every call to the native pass encoder with the same arguments', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('forward', true);
    const pass = encoder.beginRenderPass(colour());
    pass.draw(3, 2, 1, 0);
    pass.executeBundles(new Set([{} as GPURenderBundle]));
    pass.end();
    expect(fake.calls).toEqual(['draw(3,2,1,0)', 'executeBundles([1])', 'end()']);
  });
});

describe('FrameRecorder names', () => {
  it('names passes after their node, node/stage after stage(), and the node again at the next node', () => {
    const { encoder, recorder } = setUp();
    recorder.enterNode('light-groups', true);
    encoder.beginRenderPass(colour());
    recorder.enterStage('seed');
    encoder.beginRenderPass(colour());
    recorder.enterStage('sdf');
    encoder.beginRenderPass(colour());
    encoder.beginRenderPass(colour());
    recorder.enterNode('forward', true);
    encoder.beginRenderPass(colour());
    expect(recorder.pairs.map((p) => p.name)).toEqual([
      'light-groups', 'light-groups/seed', 'light-groups/sdf', 'light-groups/sdf', 'forward',
    ]);
  });

  it('profile false: no pass of that node is timed, stage() does not re-enable it, the next node is timed', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('overlay', false);
    recorder.enterStage('x');
    const d = colour();
    encoder.beginRenderPass(d);
    recorder.enterNode('forward', true);
    encoder.beginRenderPass(colour());
    expect(recorder.pairs.map((p) => p.name)).toEqual(['forward']);
    expect(fake.received[0]).toBe(d);
  });

  it('passes opened before any node, and stage() before any node, are not timed', () => {
    const { encoder, recorder } = setUp();
    recorder.enterStage('x');
    encoder.beginRenderPass(colour());
    expect(recorder.pairs).toEqual([]);
  });

  it('beyond maxPairs a pass is not timed and the frame is marked truncated', () => {
    const { encoder, fake, recorder } = setUp(2);
    recorder.enterNode('p', true);
    encoder.beginComputePass({});
    encoder.beginComputePass({});
    const third = {};
    encoder.beginComputePass(third);
    expect(recorder.pairs).toHaveLength(2);
    expect(recorder.truncated).toBe(true);
    // The caller's own descriptor, not a derived one: toEqual({}) could not tell,
    // a Proxy over an empty object equals {}.
    expect(fake.received[2]).toBe(third);
  });
});

describe('work', () => {
  it.each<[number[], boolean]>([
    [[3], true], [[0], false], [[3, 0], false], [[0.5], false], [[2.9, 1], true], [[3, 0.5], false],
  ])('drawDoesWork(%j) is %s: WebIDL reads the integer part', (args, expected) => {
    expect(drawDoesWork(...(args as [number, number?]))).toBe(expected);
  });

  it.each<[number[], boolean]>([
    [[1], true], [[0], false], [[4, 0, 1], false], [[4, 1, 0], false], [[0.9], false], [[2, 2, 2], true],
  ])('dispatchDoesWork(%j) is %s', (args, expected) => {
    expect(dispatchDoesWork(...(args as [number, number?, number?]))).toBe(expected);
  });

  const renderCases: Array<[string, boolean, (p: GPURenderPassEncoder) => void]> = [
    ['draw(3)', true, (p) => p.draw(3)],
    ['draw(0)', false, (p) => p.draw(0)],
    ['draw(3, 0)', false, (p) => p.draw(3, 0)],
    ['drawIndexed(6)', true, (p) => p.drawIndexed(6)],
    ['drawIndexed(6, 0)', false, (p) => p.drawIndexed(6, 0)],
    ['drawIndirect', true, (p) => p.drawIndirect({} as GPUBuffer, 0)],
    ['drawIndexedIndirect', true, (p) => p.drawIndexedIndirect({} as GPUBuffer, 0)],
    ['executeBundles([])', false, (p) => p.executeBundles([])],
    ['executeBundles([bundle])', true, (p) => p.executeBundles([{} as GPURenderBundle])],
    ['a clear alone', false, () => {}],
  ];
  it.each(renderCases)('a render pass with %s: work %s', (_label, expected, run) => {
    const { encoder, recorder } = setUp();
    recorder.enterNode('n', true);
    const pass = encoder.beginRenderPass(colour());
    run(pass);
    pass.end();
    expect(recorder.pairs[0].work).toBe(expected);
  });

  const computeCases: Array<[string, boolean, (p: GPUComputePassEncoder) => void]> = [
    ['dispatchWorkgroups(1)', true, (p) => p.dispatchWorkgroups(1)],
    ['dispatchWorkgroups(0)', false, (p) => p.dispatchWorkgroups(0)],
    ['dispatchWorkgroups(4, 0)', false, (p) => p.dispatchWorkgroups(4, 0)],
    ['dispatchWorkgroupsIndirect', true, (p) => p.dispatchWorkgroupsIndirect({} as GPUBuffer, 0)],
    ['no dispatch', false, () => {}],
  ];
  it.each(computeCases)('a compute pass with %s: work %s', (_label, expected, run) => {
    const { encoder, recorder } = setUp();
    recorder.enterNode('n', true);
    const pass = encoder.beginComputePass({});
    run(pass);
    pass.end();
    expect(recorder.pairs[0].work).toBe(expected);
  });

  it('executeBundles hands the native method an array, so a one-shot iterable is read once', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('n', true);
    function* bundles(): Generator<GPURenderBundle> { yield {} as GPURenderBundle; }
    encoder.beginRenderPass(colour()).executeBundles(bundles());
    expect(recorder.pairs[0].work).toBe(true);
    expect(fake.calls).toEqual(['executeBundles([1])']);
  });

  it('the work of one pass never marks the pair of another', () => {
    const { encoder, recorder } = setUp();
    recorder.enterNode('n', true);
    encoder.beginComputePass({});
    const second = encoder.beginComputePass({});
    second.dispatchWorkgroups(1);
    expect(recorder.pairs.map((p) => p.work)).toEqual([false, true]);
  });
});
