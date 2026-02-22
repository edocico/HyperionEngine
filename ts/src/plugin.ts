// plugin.ts — HyperionPlugin interface and PluginRegistry

import type { PluginContext } from './plugin-context';

export type PluginCleanup = () => void;

export interface HyperionPlugin {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: string[];
  install(ctx: PluginContext): PluginCleanup | void;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, HyperionPlugin>();
  private readonly cleanups = new Map<string, PluginCleanup>();

  install(plugin: HyperionPlugin, ctx: PluginContext): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already installed`);
    }
    this.plugins.set(plugin.name, plugin);
    const cleanup = plugin.install(ctx);
    if (cleanup) this.cleanups.set(plugin.name, cleanup);
  }

  uninstall(name: string): void {
    const cleanup = this.cleanups.get(name);
    if (cleanup) {
      cleanup();
      this.cleanups.delete(name);
    }
    this.plugins.delete(name);
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  get(name: string): HyperionPlugin | undefined {
    return this.plugins.get(name);
  }

  list(): string[] {
    return [...this.plugins.keys()];
  }

  destroyAll(): void {
    for (const cleanup of this.cleanups.values()) cleanup();
    this.cleanups.clear();
    this.plugins.clear();
  }
}
