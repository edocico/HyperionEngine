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
});
