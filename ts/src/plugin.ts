// plugin.ts — HyperionPlugin interface and PluginRegistry

export interface HyperionPlugin {
  name: string;
  install: (engine: unknown) => void;
  cleanup?: () => void;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, HyperionPlugin>();

  install(plugin: HyperionPlugin, engine: unknown): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already installed`);
    }
    this.plugins.set(plugin.name, plugin);
    plugin.install(engine);
  }

  uninstall(name: string): void {
    const plugin = this.plugins.get(name);
    if (plugin) {
      plugin.cleanup?.();
      this.plugins.delete(name);
    }
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
    for (const plugin of this.plugins.values()) {
      plugin.cleanup?.();
    }
    this.plugins.clear();
  }
}
