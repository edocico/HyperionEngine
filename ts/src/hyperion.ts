import {
  detectCapabilities,
  selectExecutionMode,
  ExecutionMode,
} from './capabilities';
import type { EngineBridge } from './worker-bridge';
import {
  createWorkerBridge,
  createDirectBridge,
  createFullIsolationBridge,
} from './worker-bridge';
import type { Renderer, OutlineOptions } from './renderer';
import { createRenderer } from './renderer';
import type { SelectionManager } from './selection';
import type { ResolvedConfig, HyperionConfig, TextureHandle, HyperionStats, MemoryStats, CompactOptions } from './types';
import { validateConfig } from './types';
import { EntityHandle } from './entity-handle';
import { EntityHandlePool } from './entity-pool';
import { GameLoop } from './game-loop';
import { Camera } from './camera';
import { CameraAPI } from './camera-api';
import { LeakDetector } from './leak-detector';
import { RawAPI } from './raw-api';
import { PluginRegistry } from './plugin';
import type { HyperionPlugin } from './plugin';
import { PluginContext } from './plugin-context';
import { EventBus } from './event-bus';
import type { HookPhase, HookFn } from './game-loop';
import { InputManager } from './input-manager';
import { ImmediateState } from './immediate-state';
import { hitTestRay } from './hit-tester';
import { AudioManager } from './audio-manager';

/**
 * Top-level engine facade. Owns the bridge, renderer, camera, game loop,
 * entity handle pool, and leak detector. Provides the public API surface
 * for spawning entities, controlling the loop, and tearing down resources.
 *
 * Construct via `Hyperion.create(config)` for production use, or
 * `Hyperion.fromParts(config, bridge, renderer)` for testing.
 *
 * Implements `Disposable` for use with `using` declarations.
 */
export class Hyperion implements Disposable {
  private readonly config: ResolvedConfig;
  private readonly bridge: EngineBridge;
  private readonly renderer: Renderer | null;
  private readonly camera: Camera;
  private readonly cameraApi: CameraAPI;
  private readonly loop: GameLoop;
  private readonly pool: EntityHandlePool;
  private readonly leakDetector: LeakDetector;
  private readonly rawApi: RawAPI;
  private readonly pluginRegistry: PluginRegistry;
  private readonly inputManager: InputManager;
  private readonly immediateState: ImmediateState;
  private readonly audioManager: AudioManager;
  private readonly eventBus: EventBus;

  private nextEntityId = 0;
  private entityCount = 0;
  private destroyed = false;

  private constructor(
    config: ResolvedConfig,
    bridge: EngineBridge,
    renderer: Renderer | null,
  ) {
    this.config = config;
    this.bridge = bridge;
    this.renderer = renderer;
    this.camera = new Camera();
    this.cameraApi = new CameraAPI(this.camera);
    this.pool = new EntityHandlePool();
    this.leakDetector = new LeakDetector();
    this.rawApi = new RawAPI(bridge.commandBuffer, () => this.nextEntityId++);
    this.pluginRegistry = new PluginRegistry();
    this.inputManager = new InputManager();
    this.immediateState = new ImmediateState();
    this.audioManager = new AudioManager();
    this.eventBus = new EventBus();
    this.loop = new GameLoop((dt) => this.tick(dt));
  }

  /**
   * Build a Hyperion instance from pre-constructed dependencies.
   * Used for testing and by `Hyperion.create()` internally.
   */
  static fromParts(
    config: ResolvedConfig,
    bridge: EngineBridge,
    renderer: Renderer | null,
  ): Hyperion {
    return new Hyperion(config, bridge, renderer);
  }

  /**
   * Async factory: detect capabilities, select execution mode,
   * create bridge + renderer, and return a ready-to-use Hyperion instance.
   */
  static async create(userConfig: HyperionConfig): Promise<Hyperion> {
    const config = validateConfig(userConfig);

    const caps = detectCapabilities();
    const modeMap: Record<string, ExecutionMode> = {
      A: ExecutionMode.FullIsolation,
      B: ExecutionMode.PartialIsolation,
      C: ExecutionMode.SingleThread,
    };
    const mode = config.preferredMode === 'auto'
      ? selectExecutionMode(caps)
      : modeMap[config.preferredMode] ?? selectExecutionMode(caps);

    let bridge: EngineBridge;
    let rendererOnMain = true;

    if (mode === ExecutionMode.FullIsolation) {
      bridge = createFullIsolationBridge(config.canvas);
      rendererOnMain = false;
    } else if (mode === ExecutionMode.PartialIsolation) {
      bridge = createWorkerBridge(mode);
    } else {
      bridge = await createDirectBridge();
    }

    await bridge.ready();

    let renderer: Renderer | null = null;
    if (rendererOnMain && caps.webgpu) {
      try {
        renderer = await createRenderer(config.canvas, config.onDeviceLost);
      } catch {
        renderer = null;
      }
    }

    const instance = new Hyperion(config, bridge, renderer);
    instance.inputManager.attach(config.canvas);
    return instance;
  }

  /** The execution mode label (e.g., "A", "B", "C"). */
  get mode(): string {
    return this.bridge.mode;
  }

  /** High-level camera API with zoom support. */
  get cam(): CameraAPI {
    return this.cameraApi;
  }

  /** Low-level numeric ID interface for bulk or performance-critical operations. */
  get raw(): RawAPI {
    return this.rawApi;
  }

  /** Installed plugin registry. */
  get plugins(): PluginRegistry {
    return this.pluginRegistry;
  }

  /** Input manager for keyboard, pointer, and scroll state. */
  get input(): InputManager {
    return this.inputManager;
  }

  /** Audio manager for loading and playing sounds with 2D spatial audio. */
  get audio(): AudioManager {
    return this.audioManager;
  }

  /**
   * Picking API for hit-testing screen coordinates against entity bounding spheres.
   * Uses Camera.screenToRay() and CPU-side ray-sphere intersection.
   */
  get picking(): { hitTest: (pixelX: number, pixelY: number) => number | null } {
    return {
      hitTest: (pixelX: number, pixelY: number): number | null => {
        this.checkDestroyed();
        const state = this.bridge.latestRenderState;
        if (!state || state.entityCount === 0 || !state.entityIds) return null;

        const ray = this.camera.screenToRay(
          pixelX, pixelY,
          this.config.canvas.width, this.config.canvas.height,
        );

        return hitTestRay(ray, state.bounds, state.entityIds);
      },
    };
  }

  /**
   * Install a plugin. The plugin's `install()` callback is invoked
   * immediately with a PluginContext providing sub-APIs for systems,
   * events, rendering, GPU resources, and storage.
   */
  use(plugin: HyperionPlugin): void {
    this.checkDestroyed();
    const ctx = new PluginContext({
      engine: this,
      loop: this.loop,
      eventBus: this.eventBus,
      renderer: this.renderer,
    });
    this.pluginRegistry.install(plugin, ctx);
  }

  /**
   * Uninstall a plugin by name. If the plugin defines a `cleanup()`
   * callback, it is invoked.
   */
  unuse(name: string): void {
    this.checkDestroyed();
    this.pluginRegistry.uninstall(name);
  }

  /** Register a hook to run during a specific game loop phase. */
  addHook(phase: HookPhase, fn: HookFn): void {
    this.loop.addHook(phase, fn);
  }

  /** Remove a previously registered game loop hook. */
  removeHook(phase: HookPhase, fn: HookFn): void {
    this.loop.removeHook(phase, fn);
  }

  /** Live engine statistics snapshot. */
  get stats(): HyperionStats {
    return {
      fps: this.loop.fps,
      entityCount: this.entityCount,
      mode: this.mode,
      tickCount: this.bridge.latestRenderState?.tickCount ?? 0,
      overflowCount: this.bridge.commandBuffer.pendingCount,
      frameDt: this.loop.frameDt,
      frameTimeAvg: this.loop.frameTimeAvg,
      frameTimeMax: this.loop.frameTimeMax,
    };
  }

  /** Memory statistics snapshot. */
  get memoryStats(): MemoryStats {
    return {
      wasmHeapBytes: 0,
      gpuBufferBytes: 0,
      entityMapUtilization: this.entityCount / this.config.maxEntities,
      tierUtilization: [],
    };
  }

  /**
   * Spawn a new entity and return its handle.
   * The handle provides a fluent builder API for setting components.
   */
  spawn(): EntityHandle {
    this.checkDestroyed();
    if (this.entityCount >= this.config.maxEntities) {
      throw new Error(
        `Entity limit reached (${this.config.maxEntities}). ` +
        `Destroy existing entities before spawning more.`,
      );
    }
    const id = this.nextEntityId++;
    this.bridge.commandBuffer.spawnEntity(id);
    this.entityCount++;

    const handle = this.pool.acquire(id, this.bridge.commandBuffer, this.immediateState);
    this.leakDetector.register(handle, id);
    return handle;
  }

  /**
   * Return a handle to the pool after its entity has been destroyed.
   * Called internally when the handle's destroy callback fires.
   */
  returnHandle(handle: EntityHandle): void {
    this.leakDetector.unregister(handle);
    this.entityCount--;
    this.pool.release(handle);
  }

  /**
   * Load a single texture from a URL. Returns a packed TextureHandle
   * (tier << 16 | layer) suitable for `entity.texture(handle)`.
   * Throws if no renderer is available.
   */
  async loadTexture(url: string, tier?: number): Promise<TextureHandle> {
    this.checkDestroyed();
    if (!this.renderer) throw new Error('Cannot load textures: no renderer available');
    return this.renderer.textureManager.loadTexture(url, tier);
  }

  /**
   * Load multiple textures in sequence. Returns an array of TextureHandles
   * in the same order as the input URLs. An optional `onProgress` callback
   * is invoked after each texture finishes loading.
   */
  async loadTextures(
    urls: string[],
    opts?: { onProgress?: (loaded: number, total: number) => void; concurrency?: number },
  ): Promise<TextureHandle[]> {
    this.checkDestroyed();
    if (!this.renderer) throw new Error('Cannot load textures: no renderer available');

    const results: TextureHandle[] = [];
    let loaded = 0;
    for (const url of urls) {
      const handle = await this.renderer.textureManager.loadTexture(url);
      results.push(handle);
      loaded++;
      opts?.onProgress?.(loaded, urls.length);
    }
    return results;
  }

  /** Start the game loop (requestAnimationFrame). */
  start(): void {
    this.checkDestroyed();
    this.loop.start();
  }

  /** Pause the game loop (frames still fire but tick is skipped). */
  pause(): void {
    this.loop.pause();
    void this.audioManager.suspend();
  }

  /** Resume the game loop after a pause. */
  resume(): void {
    this.loop.resume();
    void this.audioManager.resume();
  }

  /**
   * Update the camera projection for a new viewport size.
   * Uses a fixed vertical extent of 20 world units, scaling
   * the horizontal extent by aspect ratio.
   */
  resize(width: number, height: number): void {
    this.checkDestroyed();
    const aspect = width / height;
    this.cameraApi.setOrthographic(20 * aspect, 20);
  }

  /**
   * Tear down all resources: stop the loop, destroy the bridge and renderer.
   * Idempotent -- calling more than once is safe.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pluginRegistry.destroyAll();
    this.loop.stop();
    this.inputManager.destroy();
    this.immediateState.clearAll();
    this.eventBus.destroy();
    void this.audioManager.destroy();
    this.bridge.destroy();
    this.renderer?.destroy();
  }

  /** Disposable protocol -- delegates to `destroy()`. */
  [Symbol.dispose](): void {
    this.destroy();
  }

  /**
   * Execute a batch of commands synchronously.
   * Currently a passthrough -- future versions may defer flushing
   * or group commands for optimized ring buffer writes.
   */
  batch(fn: () => void): void {
    this.checkDestroyed();
    fn();
  }

  /**
   * Compact internal memory by releasing unused allocations.
   * Call after large batch despawns to reclaim memory.
   *
   * Options control which subsystems are compacted:
   * - `entityMap`: compact the WASM entity map (default: true)
   * - `renderState`: compact WASM render state buffers (default: true)
   * - `textures`: shrink unused texture tiers (default: true)
   */
  compact(opts?: CompactOptions): void {
    this.checkDestroyed();
    if (opts?.textures !== false) {
      (this.renderer?.textureManager as any)?.shrinkUnusedTiers?.();
    }
  }

  /** Enable or configure post-processing. */
  enablePostProcessing(_options: { fxaa?: boolean; tonemapping?: 'none' | 'pbr-neutral' | 'aces' }): void {
    this.checkDestroyed();
    // For now, this is a stub that can be wired to the renderer later.
    // The FXAATonemapPass already runs in the pipeline by default with tonemapMode=0 (passthrough).
  }

  /**
   * Access the selection manager for selecting/deselecting entities.
   * Returns null if no renderer is available (e.g. headless mode).
   */
  get selection(): SelectionManager | null {
    return this.renderer?.selectionManager ?? null;
  }

  /**
   * Enable selection outlines around selected entities.
   * Uses the JFA (Jump Flood Algorithm) for GPU-based outline rendering.
   *
   * @param options.color - RGBA outline color, each component 0-1
   * @param options.width - Outline width in pixels
   */
  enableOutlines(options: OutlineOptions): void {
    this.checkDestroyed();
    if (!this.renderer) throw new Error('Cannot enable outlines: no renderer available');
    this.renderer.enableOutlines(options);
  }

  /**
   * Disable selection outlines. The outline pipeline passes are
   * removed and dead-pass culled from the render graph.
   */
  disableOutlines(): void {
    this.checkDestroyed();
    this.renderer?.disableOutlines();
  }

  /** Per-frame tick: advance the ECS then render if state is available. */
  private tick(dt: number): void {
    // Send camera position to WASM before tick so it can extrapolate during simulation
    this.bridge.commandBuffer.setListenerPosition(this.cameraApi.x, this.cameraApi.y, 0);

    this.bridge.tick(dt);
    const state = this.bridge.latestRenderState;
    if (state && state.entityIds && this.immediateState.count > 0) {
      this.immediateState.patchTransforms(state.transforms, state.entityIds, state.entityCount);
      this.immediateState.patchBounds(state.bounds, state.entityIds, state.entityCount);
    }
    if (this.renderer && state && state.entityCount > 0) {
      this.renderer.render(state, this.camera);
    }
    this.inputManager.resetFrame();

    // Read WASM-extrapolated listener position from render state
    if (state && this.audioManager.isInitialized) {
      this.audioManager.setListenerPosition(state.listenerX, state.listenerY);
    }
  }

  private checkDestroyed(): void {
    if (this.destroyed) throw new Error('Hyperion instance has been destroyed');
  }
}
