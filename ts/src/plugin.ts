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
    if (plugin.dependencies) {
      for (const dep of plugin.dependencies) {
        if (!this.plugins.has(dep)) {
          throw new Error(`Missing dependency "${dep}" required by plugin "${plugin.name}"`);
        }
      }
    }
    this.plugins.set(plugin.name, plugin);
    try {
      const cleanup = plugin.install(ctx);
      if (cleanup) this.cleanups.set(plugin.name, cleanup);
    } catch (e) {
      this.plugins.delete(plugin.name);
      throw new Error(`Plugin "${plugin.name}" install failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  uninstall(name: string): void {
    const cleanup = this.cleanups.get(name);
    if (cleanup) {
      try { cleanup(); } catch (e) {
        console.warn(`[Hyperion] Plugin "${name}" cleanup failed:`, e);
      }
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
    for (const [name, cleanup] of this.cleanups) {
      try { cleanup(); } catch (e) {
        console.warn(`[Hyperion] Plugin "${name}" cleanup failed:`, e);
      }
    }
    this.cleanups.clear();
    this.plugins.clear();
  }
}
