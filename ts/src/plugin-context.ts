// plugin-context.ts — Full PluginContext with sub-APIs for plugins

import type { GameLoop, HookFn } from './game-loop';
import type { EventBus } from './event-bus';
import type { Renderer } from './renderer';
import type { RenderPass } from './render/render-pass';

export interface PluginSystemsAPI {
  addPreTick(fn: HookFn): void;
  removePreTick(fn: HookFn): void;
  addPostTick(fn: HookFn): void;
  removePostTick(fn: HookFn): void;
  addFrameEnd(fn: HookFn): void;
  removeFrameEnd(fn: HookFn): void;
}

export interface PluginEventAPI {
  on(event: string, fn: (data: unknown) => void): void;
  off(event: string, fn: (data: unknown) => void): void;
  once(event: string, fn: (data: unknown) => void): void;
  emit(event: string, data: unknown): void;
}

export interface PluginRenderingAPI {
  addPass(pass: RenderPass): void;
  removePass(name: string): void;
}

export interface PluginGpuAPI {
  readonly device: GPUDevice;
  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
  createTexture(descriptor: GPUTextureDescriptor): GPUTexture;
  destroyTracked(): void;
}

function createPluginGpuAPI(device: GPUDevice): PluginGpuAPI {
  const trackedBuffers: GPUBuffer[] = [];
  const trackedTextures: GPUTexture[] = [];
  return {
    device,
    createBuffer(descriptor) {
      const buf = device.createBuffer(descriptor);
      trackedBuffers.push(buf);
      return buf;
    },
    createTexture(descriptor) {
      const tex = device.createTexture(descriptor);
      trackedTextures.push(tex);
      return tex;
    },
    destroyTracked() {
      for (const buf of trackedBuffers) buf.destroy();
      for (const tex of trackedTextures) tex.destroy();
      trackedBuffers.length = 0;
      trackedTextures.length = 0;
    },
  };
}

export interface PluginStorageAPI {
  createMap<T>(name: string): Map<number, T>;
  getMap<T>(name: string): Map<number, T> | undefined;
  destroyAll(): void;
}

function createPluginStorageAPI(): PluginStorageAPI {
  const maps = new Map<string, Map<number, unknown>>();
  return {
    createMap<T>(name: string): Map<number, T> {
      if (maps.has(name)) return maps.get(name)! as Map<number, T>;
      const map = new Map<number, T>();
      maps.set(name, map as Map<number, unknown>);
      return map;
    },
    getMap<T>(name: string): Map<number, T> | undefined {
      return maps.get(name) as Map<number, T> | undefined;
    },
    destroyAll() { maps.clear(); },
  };
}

export interface PluginContextDeps {
  engine: unknown;
  loop: GameLoop;
  eventBus: EventBus;
  renderer: Renderer | null;
}

export class PluginContext {
  readonly engine: unknown;
  readonly systems: PluginSystemsAPI;
  readonly events: PluginEventAPI;
  readonly rendering: PluginRenderingAPI | null;
  readonly gpu: PluginGpuAPI | null;
  readonly storage: PluginStorageAPI;

  constructor(deps: PluginContextDeps) {
    this.engine = deps.engine;
    this.systems = {
      addPreTick: (fn) => deps.loop.addHook('preTick', fn),
      removePreTick: (fn) => deps.loop.removeHook('preTick', fn),
      addPostTick: (fn) => deps.loop.addHook('postTick', fn),
      removePostTick: (fn) => deps.loop.removeHook('postTick', fn),
      addFrameEnd: (fn) => deps.loop.addHook('frameEnd', fn),
      removeFrameEnd: (fn) => deps.loop.removeHook('frameEnd', fn),
    };
    this.events = {
      on: (event, fn) => deps.eventBus.on(event, fn),
      off: (event, fn) => deps.eventBus.off(event, fn),
      once: (event, fn) => deps.eventBus.once(event, fn),
      emit: (event, data) => deps.eventBus.emit(event, data),
    };
    this.rendering = deps.renderer ? {
      addPass: (pass) => deps.renderer!.graph.addPass(pass),
      removePass: (name) => deps.renderer!.graph.removePass(name),
    } : null;
    this.gpu = deps.renderer ? createPluginGpuAPI(deps.renderer.device) : null;
    this.storage = createPluginStorageAPI();
  }
}
