// plugin-context.ts — Full PluginContext with sub-APIs for plugins

import type { GameLoop, HookFn } from './game-loop';
import type { EventBus } from './event-bus';
import type { Renderer } from './renderer';

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
  }
}
