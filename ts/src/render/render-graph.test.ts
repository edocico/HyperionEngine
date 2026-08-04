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
