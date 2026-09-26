import { describe, it, expect, vi } from 'vitest';
import { RenderGraph } from './render-graph';
import type { RenderPass } from './render-pass';

function mockPass(name: string, reads: string[], writes: string[], optional = false): RenderPass {
  return {
    name, reads, writes, optional,
    setup: () => {},
    prepare: () => {},
    execute: () => {},
    resize: () => {},
    destroy: () => {},
  };
}

describe('RenderGraph', () => {
  it('should compile 2 passes in correct order', () => {
    const graph = new RenderGraph();
    graph.addPass(mockPass('forward', ['visible-indices'], ['swapchain']));
    graph.addPass(mockPass('cull', ['entity-transforms'], ['visible-indices']));
    const order = graph.compile();
    expect(order[0]).toBe('cull');
    expect(order[1]).toBe('forward');
  });

  it('should cull dead optional passes', () => {
    const graph = new RenderGraph();
    graph.addPass(mockPass('cull', [], ['visible-indices']));
    graph.addPass(mockPass('forward', ['visible-indices'], ['swapchain']));
    graph.addPass(mockPass('unused-optional', [], ['orphan-output'], true));
    const order = graph.compile();
    expect(order).not.toContain('unused-optional');
    expect(order.length).toBe(2);
  });

  it('should detect cycles and throw', () => {
    const graph = new RenderGraph();
    graph.addPass(mockPass('a', ['c-out'], ['a-out']));
    graph.addPass(mockPass('b', ['a-out'], ['b-out']));
    graph.addPass(mockPass('c', ['b-out'], ['c-out']));
    expect(() => graph.compile()).toThrow(/cycle/i);
  });

  it('should support addPass and removePass with lazy recompile', () => {
    const graph = new RenderGraph();
    graph.addPass(mockPass('cull', [], ['visible-indices']));
    graph.addPass(mockPass('forward', ['visible-indices'], ['swapchain']));
    graph.compile();

    graph.removePass('forward');
    expect(graph.needsRecompile).toBe(true);
  });

  it('should throw on duplicate pass name', () => {
    const graph = new RenderGraph();
    graph.addPass(mockPass('cull', [], ['out']));
    expect(() => graph.addPass(mockPass('cull', [], ['out2']))).toThrow(/already registered/);
  });

  it('should compile empty graph', () => {
    const graph = new RenderGraph();
    const order = graph.compile();
    expect(order).toEqual([]);
  });

  it('should call destroy on all passes when graph is destroyed', () => {
    const destroyFns = [vi.fn(), vi.fn()];
    const graph = new RenderGraph();
    graph.addPass({ ...mockPass('a', [], ['out']), destroy: destroyFns[0] });
    graph.addPass({ ...mockPass('b', ['out'], ['swapchain']), destroy: destroyFns[1] });
    graph.destroy();
    expect(destroyFns[0]).toHaveBeenCalledTimes(1);
    expect(destroyFns[1]).toHaveBeenCalledTimes(1);
  });

  it('should throw when two passes write the same resource', () => {
    const graph = new RenderGraph();
    graph.addPass(mockPass('a', [], ['shared-resource']));
    graph.addPass(mockPass('b', [], ['shared-resource']));
    expect(() => graph.compile()).toThrow(/multiple writers/i);
  });

  describe('read-modify-write chains', () => {
    // A pass that both reads and writes a resource layers on top of the
    // previous writer's version — an overlay drawn with loadOp 'load' onto the
    // swapchain. Two blind writes of one resource remain an error: the result
    // would depend on which one happened to run last.

    it('orders a read-modify-write pass after the blind writer it layers on', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('forward', [], ['scene-hdr']));
      graph.addPass(mockPass('composite', ['scene-hdr'], ['swapchain']));
      graph.addPass(mockPass('overlay', ['swapchain'], ['swapchain'], true));
      expect(graph.compile()).toEqual(['forward', 'composite', 'overlay']);
    });

    it('chains several read-modify-write passes in registration order', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('composite', [], ['swapchain']));
      graph.addPass(mockPass('overlay-b', ['swapchain'], ['swapchain']));
      graph.addPass(mockPass('overlay-a', ['swapchain'], ['swapchain']));
      expect(graph.compile()).toEqual(['composite', 'overlay-b', 'overlay-a']);
    });

    it('a reader outside the chain sees the final version and keeps the whole chain alive', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('base', [], ['mask'], true));
      graph.addPass(mockPass('consumer', ['mask'], ['swapchain']));
      graph.addPass(mockPass('stamp', ['mask'], ['mask'], true));
      // consumer is registered before stamp but must read stamp's version;
      // base is optional and only reachable through stamp.
      expect(graph.compile()).toEqual(['base', 'stamp', 'consumer']);
    });

    it('still rejects a blind writer registered after a read-modify-write one', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('composite', [], ['swapchain']));
      graph.addPass(mockPass('overlay', ['swapchain'], ['swapchain']));
      graph.addPass(mockPass('bloom', ['scene-hdr'], ['swapchain']));
      expect(() => graph.compile()).toThrow(/multiple writers/i);
    });

    it('a blind writer registered after a layering pass says to reorder, not to add a read', () => {
      // Adding the read would make the composite link #2 of the chain: it
      // would run AFTER the overlay and paint over it.
      const graph = new RenderGraph();
      graph.addPass(mockPass('overlay', ['swapchain'], ['swapchain']));
      graph.addPass(mockPass('composite', ['scene-hdr'], ['swapchain']));
      expect(() => graph.compile()).toThrow(/register 'overlay' after 'composite'/);
    });

    it('a cycle error names the passes caught in it', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('free', [], ['x']));
      graph.addPass(mockPass('a', ['b-out'], ['a-out']));
      graph.addPass(mockPass('b', ['a-out'], ['b-out']));
      expect(() => graph.compile()).toThrow(/cycle.*'a'.*'b'/);
    });

    it('a pass reading and writing a resource nobody wrote before is simply its first writer', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('overlay', ['swapchain'], ['swapchain']));
      expect(graph.compile()).toEqual(['overlay']);
    });
  });

  it('detachPass removes a pass without destroying it', () => {
    const destroy = vi.fn();
    const pass = { ...mockPass('overlay', ['swapchain'], ['swapchain']), destroy };
    const graph = new RenderGraph();
    graph.addPass(pass);
    expect(graph.detachPass('overlay')).toBe(pass);
    graph.destroy();
    expect(destroy).not.toHaveBeenCalled();
    expect(graph.compile()).toEqual([]);
  });

  describe('GPU profiler hook', () => {
    function mockDevice() {
      return {
        createCommandEncoder: () => ({ finish: () => ({}) }),
        queue: { submit: vi.fn() },
      } as unknown as GPUDevice;
    }

    const frame = {} as never;
    const resources = {} as never;

    function fakeProfiler(measuring: boolean) {
      return {
        beginFrame: vi.fn(() => measuring),
        mark: vi.fn(),
        endFrame: vi.fn(),
        abortFrame: vi.fn(),
        poll: vi.fn(async () => {}),
      };
    }

    it('encodes no markers when no profiler is attached', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('cull', [], ['visible-indices']));
      graph.addPass(mockPass('forward', ['visible-indices'], ['swapchain']));
      // No profiler set — must not throw and must still submit.
      const device = mockDevice();
      expect(() => graph.render(device, frame, resources)).not.toThrow();
      expect(device.queue.submit).toHaveBeenCalledTimes(1);
    });

    it('marks once per pass and closes the frame when measuring', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('cull', [], ['visible-indices']));
      graph.addPass(mockPass('forward', ['visible-indices'], ['swapchain']));
      const profiler = fakeProfiler(true);
      graph.setProfiler(profiler as never);

      graph.render(mockDevice(), frame, resources);

      expect(profiler.beginFrame).toHaveBeenCalledWith(['cull', 'forward']);
      expect(profiler.mark).toHaveBeenCalledTimes(2);
      expect(profiler.endFrame).toHaveBeenCalledTimes(1);
      expect(profiler.poll).toHaveBeenCalledTimes(1);
    });

    // A pass that runs several stages of its own (LightGroupsPass: seed, sdf,
    // accum per SDF set) names them for the frame and marks them itself, so the
    // profiler reports each stage instead of one lump.
    it('a staged pass marks its own stages, named pass/stage', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('p0', [], ['a']));
      const staged = mockPass('staged', ['a'], ['b']);
      const execute = vi.fn((encoder: GPUCommandEncoder, _f: unknown, _r: unknown, mark?: (e: GPUCommandEncoder) => void) => {
        mark?.(encoder); mark?.(encoder); mark?.(encoder);
      });
      Object.assign(staged, { profileStages: () => ['a', 'b', 'a'], execute });
      graph.addPass(staged);
      graph.addPass(mockPass('p2', ['b'], ['swapchain']));
      const profiler = fakeProfiler(true);
      graph.setProfiler(profiler as never);

      graph.render(mockDevice(), frame, resources);

      expect(profiler.beginFrame).toHaveBeenCalledWith(['p0', 'staged/a', 'staged/b', 'staged/a', 'p2']);
      // p0 and p2 by the graph, three stages by the pass itself: not one before it.
      expect(profiler.mark).toHaveBeenCalledTimes(5);
      expect(execute.mock.calls[0][3]).toBeTypeOf('function');
    });

    it('a staged pass gets no mark function when the frame is not measured', () => {
      const graph = new RenderGraph();
      const staged = mockPass('staged', [], ['swapchain']);
      const execute = vi.fn();
      Object.assign(staged, { profileStages: () => ['a'], execute });
      graph.addPass(staged);
      graph.setProfiler(fakeProfiler(false) as never);
      graph.render(mockDevice(), frame, resources);
      expect(execute.mock.calls[0][3]).toBeUndefined();
    });

    it('skips marking entirely when beginFrame declines the frame', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('forward', [], ['swapchain']));
      const profiler = fakeProfiler(false);
      graph.setProfiler(profiler as never);

      graph.render(mockDevice(), frame, resources);

      expect(profiler.mark).not.toHaveBeenCalled();
      expect(profiler.endFrame).not.toHaveBeenCalled();
      expect(profiler.poll).not.toHaveBeenCalled();
    });

    it('detaching the profiler restores the unmeasured path', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('forward', [], ['swapchain']));
      const profiler = fakeProfiler(true);
      graph.setProfiler(profiler as never);
      graph.setProfiler(null);

      graph.render(mockDevice(), frame, resources);
      expect(profiler.beginFrame).not.toHaveBeenCalled();
    });

    it('closes the open frame when a pass throws, then rethrows', () => {
      const graph = new RenderGraph();
      const boom = mockPass('boom', [], ['swapchain']);
      boom.execute = () => { throw new Error('pass exploded'); };
      graph.addPass(boom);
      const profiler = fakeProfiler(true);
      graph.setProfiler(profiler as never);

      // Without abortFrame() the profiler's frame stays open and every later
      // beginFrame() returns false — it would go silently dead.
      expect(() => graph.render(mockDevice(), frame, resources)).toThrow('pass exploded');
      expect(profiler.abortFrame).toHaveBeenCalledTimes(1);
      expect(profiler.endFrame).not.toHaveBeenCalled();
      expect(profiler.poll).not.toHaveBeenCalled();
    });

    it('does not abort the frame when every pass succeeds', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('forward', [], ['swapchain']));
      const profiler = fakeProfiler(true);
      graph.setProfiler(profiler as never);

      graph.render(mockDevice(), frame, resources);
      expect(profiler.abortFrame).not.toHaveBeenCalled();
      expect(profiler.endFrame).toHaveBeenCalledTimes(1);
    });

    it('marks only live passes, not dead-culled ones', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('forward', [], ['swapchain']));
      graph.addPass(mockPass('orphan', [], ['nobody-reads-this'], true));
      const profiler = fakeProfiler(true);
      graph.setProfiler(profiler as never);

      graph.render(mockDevice(), frame, resources);

      expect(profiler.beginFrame).toHaveBeenCalledWith(['forward']);
      expect(profiler.mark).toHaveBeenCalledTimes(1);
    });
  });
});
