import { describe, it, expect, vi } from 'vitest';
import { PluginRegistry, type HyperionPlugin } from './plugin';
import type { PluginContext } from './plugin-context';

function mockCtx(): PluginContext {
  return {} as PluginContext;
}

describe('PluginRegistry', () => {
  it('install adds a plugin and calls install(ctx)', () => {
    const registry = new PluginRegistry();
    const installFn = vi.fn();
    const plugin: HyperionPlugin = { name: 'test', version: '1.0.0', install: installFn };
    registry.install(plugin, mockCtx());
    expect(registry.has('test')).toBe(true);
    expect(installFn).toHaveBeenCalled();
  });

  it('uninstall calls returned cleanup function', () => {
    const registry = new PluginRegistry();
    const cleanup = vi.fn();
    const plugin: HyperionPlugin = {
      name: 'test', version: '1.0.0',
      install: () => cleanup,
    };
    registry.install(plugin, mockCtx());
    registry.uninstall('test');
    expect(registry.has('test')).toBe(false);
    expect(cleanup).toHaveBeenCalled();
  });

  it('uninstall works when plugin returns no cleanup', () => {
    const registry = new PluginRegistry();
    const plugin: HyperionPlugin = {
      name: 'test', version: '1.0.0',
      install: () => {},
    };
    registry.install(plugin, mockCtx());
    registry.uninstall('test');
    expect(registry.has('test')).toBe(false);
  });

  it('list returns installed plugin names', () => {
    const registry = new PluginRegistry();
    registry.install({ name: 'a', version: '1.0.0', install: vi.fn() }, mockCtx());
    registry.install({ name: 'b', version: '1.0.0', install: vi.fn() }, mockCtx());
    expect(registry.list()).toEqual(['a', 'b']);
  });

  it('get returns plugin by name', () => {
    const registry = new PluginRegistry();
    const plugin: HyperionPlugin = { name: 'test', version: '1.0.0', install: vi.fn() };
    registry.install(plugin, mockCtx());
    expect(registry.get('test')).toBe(plugin);
  });

  it('throws on duplicate plugin name', () => {
    const registry = new PluginRegistry();
    registry.install({ name: 'x', version: '1.0.0', install: vi.fn() }, mockCtx());
    expect(() =>
      registry.install({ name: 'x', version: '1.0.0', install: vi.fn() }, mockCtx()),
    ).toThrow('already installed');
  });

  it('destroyAll calls all cleanups', () => {
    const registry = new PluginRegistry();
    const c1 = vi.fn();
    const c2 = vi.fn();
    registry.install({ name: 'a', version: '1.0.0', install: () => c1 }, mockCtx());
    registry.install({ name: 'b', version: '1.0.0', install: () => c2 }, mockCtx());
    registry.destroyAll();
    expect(c1).toHaveBeenCalled();
    expect(c2).toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
  });
});
