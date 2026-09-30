import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, type MockInstance } from 'vitest';
import { GpuProfiler } from './gpu-profiler';
import { RenderGraph } from './render-graph';
import type { RenderPass } from './render-pass';
import { installGpuGlobals, makeGpu, stampsOf, type FakeCommandBuffer, type Gpu } from './gpu-profiler.fixture';

beforeAll(installGpuGlobals);

/**
 * The parts of the GPU profiler that no other test runs together: RenderGraph.render()
 * with the REAL GpuProfiler, the real interception of the encoder and the real frame
 * evaluation, on the fixture's device. Only the passes are mocks, and they open real
 * (fake) passes on the encoder the graph hands them. gpu-profiler.test.ts drives the
 * profiler by hand and render-graph.test.ts drives the graph with a fake profiler.
 */

interface Seen {
  encoder: GPUCommandEncoder;
  stage: ((name: string) => void) | undefined;
}

/**
 * Four nodes in a chain, and what each does on the encoder it receives:
 *   cull    a compute pass with a dispatch;
 *   staged  stage('a'), a compute pass with work, stage('b'), another;
 *   optout  `profile: false`, a compute pass with work;
 *   idle    a compute pass that dispatches nothing.
 * `seen` keeps what each node's execute received, `opened` the passes it opened.
 */
function makeScene() {
  const seen = new Map<string, Seen>();
  const opened: string[] = [];
  const control = { throwIn: null as string | null };

  const open = (encoder: GPUCommandEncoder, label: string, work: boolean) => {
    opened.push(label);
    const pass = encoder.beginComputePass({ label });
    if (work) pass.dispatchWorkgroups(1);
    pass.end();
  };

  const node = (
    name: string, reads: string[], writes: string[],
    run: (encoder: GPUCommandEncoder, stage: Seen['stage']) => void,
    profile?: boolean,
  ): RenderPass => ({
    name, reads, writes, optional: false, profile,
    setup: () => {}, prepare: () => {}, resize: () => {}, destroy: () => {},
    execute: (encoder, _frame, _resources, stage) => {
      seen.set(name, { encoder, stage });
      run(encoder, stage);
    },
  });

  const passes = [
    node('cull', [], ['culled'], (encoder) => open(encoder, 'cull', true)),
    node('staged', ['culled'], ['staged-out'], (encoder, stage) => {
      stage?.('a');
      open(encoder, 'staged-a', true);
      if (control.throwIn === 'staged') throw new Error('staged exploded');
      stage?.('b');
      open(encoder, 'staged-b', true);
    }),
    node('optout', ['staged-out'], ['optout-out'], (encoder) => open(encoder, 'optout', true), false),
    node('idle', ['optout-out'], ['swapchain'], (encoder) => open(encoder, 'idle', false)),
  ];
  return { passes, seen, opened, control };
}

const NODES = ['cull', 'staged', 'optout', 'idle'];
/** render() starts poll() and never awaits it: let that promise chain (fakes that resolve at once) finish. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('GpuProfiler driven by RenderGraph.render()', () => {
  let gpu: Gpu;
  let scene: ReturnType<typeof makeScene>;
  let graph: RenderGraph;
  let profiler: GpuProfiler;
  let warn: MockInstance<typeof console.warn>;
  let error: MockInstance<typeof console.error>;
  const frame = {} as never;
  const resources = {} as never;

  beforeEach(() => {
    gpu = makeGpu();
    scene = makeScene();
    graph = new RenderGraph();
    for (const pass of scene.passes) graph.addPass(pass);
    profiler = new GpuProfiler(gpu.device);
    graph.setProfiler(profiler);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  /**
   * One frame through the graph's own render(). The passes write these stamps when the queue runs the
   * frame: pairs of 0.25, 1, 2 and 3 ms, in the order the interception gave them out (10 ms apart).
   */
  async function renderFrame(n: number): Promise<void> {
    scene.opened.length = 0;
    gpu.stampsForNextSubmit(stampsOf(n, 0.25, 1, 2, 3));
    graph.render(gpu.device, frame, resources);
    await settle();
  }

  it('times every node and stage that did work, reports the idle one at 0 ms, and leaves the opted-out node out', async () => {
    for (let n = 0; n < 5; n++) await renderFrame(n);
    // Every node opened its passes: 'optout' is missing below because it opted out, not because it never ran.
    expect(scene.opened).toEqual(['cull', 'staged-a', 'staged-b', 'optout', 'idle']);
    const timings = profiler.getTimingsByName();
    expect([...timings.keys()].sort()).toEqual(['cull', 'idle', 'staged/a', 'staged/b']);
    expect(timings.get('cull')?.averageMs).toBeCloseTo(0.25, 6);
    expect(timings.get('staged/a')?.averageMs).toBeCloseTo(1, 6);
    expect(timings.get('staged/b')?.averageMs).toBeCloseTo(2, 6);
    // 'idle' dispatched nothing: 0 ms, although the stamps of its pair say 3.
    expect(timings.get('idle')).toMatchObject({ averageMs: 0, lastMs: 0 });
    for (const timing of timings.values()) expect(timing.sampleCount).toBe(5);
    // From cull's beginning to staged/b's end: the idle pair comes later but did no work, so it adds nothing.
    const span = profiler.frameTiming();
    expect(span?.sampleCount).toBe(5);
    expect(span?.averageMs).toBeCloseTo(22, 6);
    expect(profiler.discardedFrames).toBe(0);
    expect(profiler.skippedFrames).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('hands a stage function to the profiled nodes and none to the node that opted out', async () => {
    await renderFrame(0);
    // A measured frame: the graph put the profiler's wrapper on the encoder it hands every node.
    expect(Object.hasOwn(scene.seen.get('cull')!.encoder, 'beginComputePass')).toBe(true);
    expect(scene.seen.get('cull')!.stage).toBeTypeOf('function');
    expect(scene.seen.get('staged')!.stage).toBeTypeOf('function');
    expect(scene.seen.get('optout')!.stage).toBeUndefined();
    expect(scene.seen.get('idle')!.stage).toBeTypeOf('function');
  });

  it('a pass that throws aborts the frame: the error propagates, nothing is submitted, the next frame is measured normally', async () => {
    await renderFrame(0);
    expect(profiler.getTimingsByName().get('cull')?.sampleCount).toBe(1);
    const submits = gpu.queueSubmit.mock.calls.length;

    // 'staged' throws after its first stage opened a pass: two pairs are taken and the encoder is abandoned.
    scene.control.throwIn = 'staged';
    gpu.stampsForNextSubmit(stampsOf(1, 0.25, 1, 2, 3));
    expect(() => graph.render(gpu.device, frame, resources)).toThrow('staged exploded');
    await settle();
    expect(gpu.queueSubmit).toHaveBeenCalledTimes(submits);
    expect(profiler.measuring).toBe(false);

    // Were the frame still open, beginFrame() would refuse and the profiler would go quiet for good.
    scene.control.throwIn = null;
    await renderFrame(2);
    await renderFrame(3);
    expect(profiler.getTimingsByName().get('cull')?.sampleCount).toBe(3);
    expect(profiler.getTimingsByName().get('staged/b')?.sampleCount).toBe(3);
    expect(profiler.discardedFrames).toBe(0);
    expect(profiler.skippedFrames).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('with the profiler detached the encoder stays native, no pass receives a stage function, and no profiler command is encoded', async () => {
    await renderFrame(0);
    const measured = Array.from(gpu.queueSubmit.mock.calls.at(-1)![0] as FakeCommandBuffer[]);
    // Contrast: the measured frame carries the profiler's resolve and copies.
    expect(measured.flatMap((commandBuffer) => commandBuffer.ops).length).toBeGreaterThan(0);
    const writes = gpu.writeBuffer.mock.calls.length;

    graph.setProfiler(null);
    scene.seen.clear();
    await renderFrame(1);
    for (const name of NODES) {
      const seen = scene.seen.get(name)!;
      expect(Object.hasOwn(seen.encoder, 'beginComputePass'), name).toBe(false);
      expect(Object.hasOwn(seen.encoder, 'beginRenderPass'), name).toBe(false);
      expect(seen.stage, name).toBeUndefined();
    }
    const unmeasured = Array.from(gpu.queueSubmit.mock.calls.at(-1)![0] as FakeCommandBuffer[]);
    expect(unmeasured.flatMap((commandBuffer) => commandBuffer.ops)).toEqual([]);
    expect(gpu.writeBuffer).toHaveBeenCalledTimes(writes);
    expect(profiler.getTimingsByName().get('cull')?.sampleCount).toBe(1);
  });
});
