import { describe, it, expect, vi } from 'vitest';
import { PluginRegistry, type HyperionPlugin } from './plugin';

describe('PluginRegistry', () => {
  it('install adds a plugin', () => {
    const registry = new PluginRegistry();
    const plugin: HyperionPlugin = {
      name: 'test-plugin',
      install: vi.fn(),
      cleanup: vi.fn(),
    };
    registry.install(plugin, {} as any);
    expect(registry.has('test-plugin')).toBe(true);
    expect(plugin.install).toHaveBeenCalled();
  });

  it('uninstall removes and calls cleanup', () => {
    const registry = new PluginRegistry();
    const plugin: HyperionPlugin = {
      name: 'test-plugin',
      install: vi.fn(),
      cleanup: vi.fn(),
    };
    registry.install(plugin, {} as any);
    registry.uninstall('test-plugin');
    expect(registry.has('test-plugin')).toBe(false);
    expect(plugin.cleanup).toHaveBeenCalled();
  });

  it('list returns installed plugin names', () => {
    const registry = new PluginRegistry();
    registry.install({ name: 'a', install: vi.fn() }, {} as any);
    registry.install({ name: 'b', install: vi.fn() }, {} as any);
    expect(registry.list()).toEqual(['a', 'b']);
  });

  it('get returns plugin by name', () => {
    const registry = new PluginRegistry();
    const plugin: HyperionPlugin = { name: 'test', install: vi.fn() };
    registry.install(plugin, {} as any);
    expect(registry.get('test')).toBe(plugin);
  });

  it('throws on duplicate plugin name', () => {
    const registry = new PluginRegistry();
    registry.install({ name: 'x', install: vi.fn() }, {} as any);
    expect(() =>
      registry.install({ name: 'x', install: vi.fn() }, {} as any)
    ).toThrow('already installed');
  });
});
