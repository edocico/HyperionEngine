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
import type { PassTiming } from './render/gpu-profiler';
import type { PixelProbeRequest, PixelProbeResult, TransformsProbeResult } from './render/debug-probe';
import type { BloomConfig } from './render/passes/bloom-pass';
import { createRenderer } from './renderer';
import type { SelectionManager } from './selection';
import type { ResolvedConfig, HyperionConfig, TextureHandle, HyperionStats, MemoryStats, CompactOptions, SpawnOptions } from './types';
import { validateConfig, spawnIs2D } from './types';
import { EntityIdAllocator, type IdOwner } from './entity-id-allocator';
import { EntityHandle } from './entity-handle';
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
import { ProfilerOverlay } from './profiler';
import type { ProfilerConfig } from './profiler';
import { DEFAULT_PARTICLE_CONFIG } from './particle-types';
import type { ParticleEmitterConfig, ParticleHandle } from './particle-types';
import { PrefabRegistry } from './prefab/registry';
import { CommandTapeRecorder } from './replay/command-tape';
import type { CommandTape } from './replay/command-tape';
import { PhysicsAPI } from './physics-api';
import { LightingAPI } from './lighting-api';

const NO_DEBUG_PROBE = 'The debug probe needs the main-thread renderer of a dev build (Mode B or C, not Mode A or headless)';
const PROBE_PAUSED = 'The engine is paused: the debug probe reads the next rendered frame';

/**
 * Top-level engine facade. Owns the bridge, renderer, camera, game loop,
 * entity id allocation, and leak detector. Provides the public API surface
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
  private readonly leakDetector: LeakDetector;
  private readonly rawApi: RawAPI;
  private readonly pluginRegistry: PluginRegistry;
  private readonly inputManager: InputManager;
  private readonly immediateState: ImmediateState;
  private readonly audioManager: AudioManager;
  private readonly eventBus: EventBus;
  private readonly physicsApi: PhysicsAPI;
  private readonly lightingApi: LightingAPI;
  private readonly prefabRegistry: PrefabRegistry;

  /** External entity ids, reused under quarantine (not readonly: tests shrink it). */
  private ids = new EntityIdAllocator();
  private warnedRawDespawn = false;
  private entityCount = 0;
  private destroyed = false;
  private profiler: ProfilerOverlay | null = null;
  private profilerHook: ((dt: number) => void) | null = null;
  private recorder: CommandTapeRecorder | null = null;

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
    this.leakDetector = new LeakDetector();
    this.rawApi = new RawAPI(bridge.commandBuffer, {
      allocate: () => this.allocateId('raw'),
      release: (id) => this.releaseRawId(id),
      isLive: (id) => this.ids.isLive(id),
    });
    // The quarantine of a freed id starts when its DespawnEntity is WRITTEN:
    // it is consumed by the next tick the bridge sends at the latest.
    bridge.commandBuffer.setDespawnWrittenListener((id) =>
      this.ids.written(id, bridge.nextTickSeq ?? Number.POSITIVE_INFINITY));
    bridge.commandBuffer.setReferenceGuard((id) => !this.ids.isQuarantined(id));
    this.pluginRegistry = new PluginRegistry();
    this.inputManager = new InputManager();
    this.immediateState = new ImmediateState();
    this.audioManager = new AudioManager();
    this.eventBus = new EventBus();
    this.physicsApi = new PhysicsAPI();
    this.physicsApi._initProducer(bridge.commandBuffer);
    this.lightingApi = new LightingAPI();
    this.lightingApi._init(bridge.commandBuffer, bridge, () => this.camera.viewProjection);
    this.prefabRegistry = new PrefabRegistry(this);
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
    const preferredMode = config.preferredMode === 'auto'
      ? selectExecutionMode(caps)
      : modeMap[config.preferredMode] ?? selectExecutionMode(caps);

    // Build the fallback chain: try preferred mode, then degrade gracefully
    const fallbackChain: ExecutionMode[] = [];
    if (preferredMode === ExecutionMode.FullIsolation) {
      fallbackChain.push(ExecutionMode.FullIsolation, ExecutionMode.PartialIsolation, ExecutionMode.SingleThread);
    } else if (preferredMode === ExecutionMode.PartialIsolation) {
      fallbackChain.push(ExecutionMode.PartialIsolation, ExecutionMode.SingleThread);
    } else {
      fallbackChain.push(ExecutionMode.SingleThread);
    }

    let bridge: EngineBridge | null = null;
    let rendererOnMain = true;

    for (const mode of fallbackChain) {
      try {
        if (mode === ExecutionMode.FullIsolation) {
          // Quick adapter check — transferControlToOffscreen is irreversible,
          // so verify WebGPU works before committing the canvas to a worker.
          const adapter = await navigator.gpu?.requestAdapter();
          if (!adapter) {
            console.warn('[Hyperion] No WebGPU adapter on main thread, skipping Mode A');
            continue;
          }
          bridge = createFullIsolationBridge(config.canvas);
          rendererOnMain = false;
        } else if (mode === ExecutionMode.PartialIsolation && caps.sharedArrayBuffer) {
          bridge = createWorkerBridge(mode);
          rendererOnMain = true;
        } else {
          bridge = await createDirectBridge();
          rendererOnMain = true;
        }
        await bridge.ready();
        break;
      } catch (err) {
        console.warn(`[Hyperion] Mode ${mode} failed, trying next fallback:`, err);
        bridge?.destroy();
        bridge = null;
        rendererOnMain = true;
      }
    }

    if (!bridge) {
      // Last resort: Mode C should always work
      bridge = await createDirectBridge();
      await bridge.ready();
      rendererOnMain = true;
    }

    let renderer: Renderer | null = null;
    if (rendererOnMain && caps.webgpu) {
      try {
        renderer = await createRenderer(config.canvas, config.onDeviceLost, config.scatterThreshold);
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

  /** Prefab registry for declarative entity composition. */
  get prefabs(): PrefabRegistry {
    return this.prefabRegistry;
  }

  /** Input manager for keyboard, pointer, and scroll state. */
  get input(): InputManager {
    return this.inputManager;
  }

  /** Audio manager for loading and playing sounds with 2D spatial audio. */
  get audio(): AudioManager {
    return this.audioManager;
  }

  /** Physics API for collision events, sensor callbacks, and scene queries. */
  get physics(): PhysicsAPI {
    return this.physicsApi;
  }

  /**
   * 2D lighting (Phase 17).
   *
   * Individual lights are entities — `engine.spawn().light({...})`. This
   * sub-API is only the engine-wide state: which backend runs, the ambient
   * term, and the quality knobs.
   */
  get lighting(): LightingAPI {
    return this.lightingApi;
  }

  /**
   * Debug API for time-travel recording controls.
   * Start/stop command recording to produce a CommandTape snapshot.
   * Returns null in production builds (__DEV__ === false) to enable
   * tree-shaking of debug/replay modules.
   */
  get debug() {
    if (typeof __DEV__ !== 'undefined' && !__DEV__) return null;
    const self = this;
    return {
      get isRecording(): boolean {
        return self.recorder !== null;
      },
      startRecording(config?: { maxEntries?: number }): void {
        if (self.recorder) return;
        self.recorder = new CommandTapeRecorder(config);
        self.bridge.commandBuffer.setRecordingTap((type, entityId, payload) => {
          const tick = self.bridge.latestRenderState?.tickCount ?? 0;
          self.recorder?.record({
            tick,
            timestamp: performance.now(),
            type,
            entityId,
            payload: new Uint8Array(payload),
          });
        });
      },
      stopRecording(): CommandTape | null {
        if (!self.recorder) return null;
        const tape = self.recorder.stop();
        self.recorder = null;
        self.bridge.commandBuffer.setRecordingTap(null);
        return tape;
      },
      /**
       * Reads pixels of the NEXT rendered frame: `scene-hdr` and `light-buffer`
       * in linear HDR, the `swapchain` as displayed (0-1). Points in world
       * units (placed with that frame's camera) or UV. Needs the main-thread
       * renderer of a dev build: Mode B/C; rejects in Mode A and headless, and
       * while paused. An empty world renders too (its frame is the clear).
       */
      probe(request: PixelProbeRequest): Promise<PixelProbeResult> {
        const probe = self.renderer?.debugProbe;
        if (!probe) return Promise.reject(new Error(NO_DEBUG_PROBE));
        if (self.loop.paused) return Promise.reject(new Error(PROBE_PAUSED));
        return probe.pixels(request);
      },
      /**
       * Reads the `entity-transforms` rows back at the next rendered frame,
       * next to the CPU rows of that frame and whether it used the scatter
       * upload. Same availability as `probe`.
       */
      readEntityTransforms(): Promise<TransformsProbeResult> {
        const probe = self.renderer?.debugProbe;
        if (!probe) return Promise.reject(new Error(NO_DEBUG_PROBE));
        if (self.loop.paused) return Promise.reject(new Error(PROBE_PAUSED));
        return probe.transforms();
      },
      /**
       * Toggle physics debug rendering (Phase 16). Sends CommandType 47;
       * only effective on physics-debug WASM builds (no-op otherwise).
       */
      setPhysicsDebugRender(enabled: boolean): void {
        self.bridge.commandBuffer.setPhysicsDebugRender(enabled);
      },
      /**
       * Determinism harness (Phase 16): canonical FNV-1a 64 state hash.
       * Resolves null on non-dev-tools WASM builds.
       */
      stateHash(): Promise<bigint | null> {
        return self.bridge.getStateHash?.() ?? Promise.resolve(null);
      },
    };
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

        return hitTestRay(ray, state.bounds, state.entityIds, undefined, state.renderMeta);
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
   * `spawn({ mode: '2d' })` makes a Transform2D entity (see `SpawnOptions`).
   */
  spawn(options?: SpawnOptions): EntityHandle {
    this.checkDestroyed();
    const is2D = spawnIs2D(options);
    if (this.entityCount >= this.config.maxEntities) {
      throw new Error(
        `Entity limit reached (${this.config.maxEntities}). ` +
        `Destroy existing entities before spawning more.`,
      );
    }
    const id = this.allocateId('handle');
    this.bridge.commandBuffer.spawnEntity(id, is2D);
    this.entityCount++;

    const handle = new EntityHandle(id, this.bridge.commandBuffer, this.immediateState, this.releaseHandle, is2D);
    this.leakDetector.register(handle, id);
    return handle;
  }

  /**
   * Frees a destroyed handle's slot: its `destroy()` calls this once. The
   * handle is not recycled, so a stale reference can never alias a newer
   * entity; its id goes into quarantine (EntityIdAllocator).
   */
  private readonly releaseHandle = (handle: EntityHandle): void => {
    this.leakDetector.unregister(handle);
    this.entityCount--;
    this.ids.free(handle.id);
    this.forgetId(handle.id);
  };

  /**
   * Allocates an external id. A reused one is scrubbed again first: state can
   * be set on an id after it was freed (a selection from a pick on the
   * previous frame's state, an emitter), and none of it may reach the new
   * entity.
   */
  private allocateId(owner: IdOwner): number {
    const reused = !this.ids.hasFreshIds;
    const id = this.ids.allocate(owner);
    if (reused) {
      this.forgetId(id);
      this.physicsApi._forgetEntity(id);
    }
    return id;
  }

  /** `raw.despawn(id)`: returns whether the despawn should be sent. */
  private releaseRawId(id: number): boolean {
    const owner = this.ids.ownerOf(id);
    if (owner === 'handle') {
      throw new Error(`Entity ${id} belongs to an EntityHandle: destroy it with handle.destroy(), not raw.despawn().`);
    }
    if (owner === null) {
      if (!this.warnedRawDespawn && typeof __DEV__ !== 'undefined' && __DEV__) {
        this.warnedRawDespawn = true;
        console.warn(`[Hyperion] raw.despawn(${id}): not a live entity (already despawned, or never spawned). Ignored; further ones are silent.`);
      }
      return false;
    }
    this.ids.free(id);
    this.forgetId(id);
    return true;
  }

  /**
   * Main-thread state keyed by a freed id, dropped as soon as it is freed:
   * the entity that reuses the id must inherit none of it. State an event of
   * the old entity may still need is dropped at release instead (`tick`).
   */
  private forgetId(id: number): void {
    this.immediateState.clear(id);
    this.renderer?.selectionManager.deselect(id);
    this.renderer?.particleSystem.forgetEntity(id);
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
    // In Mode A the canvas is owned by the render worker — forward resize there.
    // In Mode B/C the main thread owns the canvas — set dimensions directly.
    if (this.bridge.resize) {
      this.bridge.resize(width, height);
    } else {
      this.config.canvas.width = width;
      this.config.canvas.height = height;
    }
  }

  /**
   * Tear down all resources: stop the loop, destroy the bridge and renderer.
   * Idempotent -- calling more than once is safe.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disableProfiler();
    this.pluginRegistry.destroyAll();
    this.loop.stop();
    this.inputManager.destroy();
    this.immediateState.clearAll();
    this.eventBus.destroy();
    void this.audioManager.destroy();
    this.physicsApi.destroy();
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

  /** Show a performance profiler overlay on the canvas. */
  enableProfiler(config?: ProfilerConfig): void {
    this.checkDestroyed();
    if (this.profiler) return;
    this.profiler = new ProfilerOverlay(config);
    this.profiler.show(this.config.canvas);
    this.profilerHook = () => this.profiler?.update(this.stats);
    this.loop.addHook('postTick', this.profilerHook);
  }

  /** Hide the performance profiler overlay. */
  disableProfiler(): void {
    if (!this.profiler) return;
    if (this.profilerHook) {
      this.loop.removeHook('postTick', this.profilerHook);
      this.profilerHook = null;
    }
    this.profiler.destroy();
    this.profiler = null;
  }

  /**
   * Whether per-pass GPU timing is available — needs a local renderer on a
   * device that exposes the `timestamp-query` feature.
   *
   * Not the same thing as {@link enableProfiler}, which is a DOM overlay of CPU
   * frame stats. This one measures where the frame actually goes on the GPU.
   */
  get gpuProfilingSupported(): boolean {
    return this.renderer?.gpuProfilingSupported ?? false;
  }

  /**
   * Start measuring per-pass GPU time. Returns false when the feature is
   * missing, and in any context without a local renderer — headless, or the
   * main thread in Mode A, where rendering happens in the Render Worker.
   *
   * Read the numbers back with {@link getGpuTimings}, and quote `averageMs`
   * rather than `lastMs`: Chrome quantizes GPU timestamps to 100us by default,
   * so only the rolling mean carries usable resolution.
   */
  enableGpuProfiling(): boolean {
    this.checkDestroyed();
    return this.renderer?.enableGpuProfiling() ?? false;
  }

  /** Stop measuring per-pass GPU time. */
  disableGpuProfiling(): void {
    this.renderer?.disableGpuProfiling();
  }

  /**
   * Per-pass GPU timings (a staged pass reports `pass/stage` entries), one
   * entry per name measured in the last 120 resolved frames: a frame without
   * it counts as 0 ms, so every `averageMs` is a mean per frame and every
   * entry has the same `sampleCount`. Empty when profiling is off,
   * unsupported, or still warming up — treat a `sampleCount` below ~30 as not
   * yet meaningful.
   */
  getGpuTimings(): PassTiming[] {
    return this.renderer?.getGpuTimings() ?? [];
  }

  /**
   * Access the selection manager for selecting/deselecting entities.
   * Returns null if no renderer is available (e.g. headless mode).
   */
  get selection(): SelectionManager | null {
    return this.renderer?.selectionManager ?? null;
  }

  /** GPU-compressed texture format in use, or null if unsupported. */
  get compressionFormat(): GPUTextureFormat | null {
    return this.renderer?.textureManager.compressedFormat ?? null;
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
   * Disable selection outlines. The render graph is rebuilt without the
   * outline chain, and FXAATonemapPass is the final composite again.
   */
  disableOutlines(): void {
    this.checkDestroyed();
    this.renderer?.disableOutlines();
  }

  /**
   * Enable Dual Kawase bloom post-processing.
   * Mutually exclusive with outlines (enabling bloom disables outlines).
   *
   * @param config - Optional bloom configuration (threshold, intensity, tonemapMode)
   * @throws If no renderer is available (headless mode)
   */
  enableBloom(config?: BloomConfig): void {
    this.checkDestroyed();
    if (!this.renderer) throw new Error('Cannot enable bloom: no renderer available');
    this.renderer.enableBloom(config);
  }

  /**
   * Disable bloom post-processing. Restores the standard FXAA/tonemap pipeline.
   */
  disableBloom(): void {
    this.checkDestroyed();
    this.renderer?.disableBloom();
  }

  /**
   * Recompile a named shader with new WGSL source (dev tool). For a primitive
   * ('basic'/'quad', 'line', 'msdf-text', 'bezier', 'gradient', 'box-shadow')
   * the source is that primitive's library piece, not a whole module.
   */
  recompileShader(passName: string, shaderCode: string): void {
    this.checkDestroyed();
    this.renderer?.recompileShader(passName, shaderCode);
  }

  /**
   * Create a GPU particle emitter. Particles are simulated and rendered
   * entirely on the GPU, independent of the ECS. Optionally tracks an
   * entity's position as the emitter origin.
   *
   * @param config - Partial config merged with DEFAULT_PARTICLE_CONFIG
   * @param entityId - Optional external entity ID to track position from
   * @returns ParticleHandle for later destruction, or null if no renderer (Mode A)
   */
  createParticleEmitter(config: Partial<ParticleEmitterConfig>, entityId?: number): ParticleHandle | null {
    this.checkDestroyed();
    if (!this.renderer) return null;
    const merged = { ...DEFAULT_PARTICLE_CONFIG, ...config };
    return this.renderer.particleSystem.createEmitter(merged, entityId);
  }

  /**
   * Destroy a GPU particle emitter and release its GPU resources.
   * Safe to call even without a renderer (no-op).
   */
  destroyParticleEmitter(handle: ParticleHandle | null): void {
    this.checkDestroyed();
    if (handle !== null) this.renderer?.particleSystem.destroyEmitter(handle);
  }

  /** Per-frame tick: advance the ECS then render if state is available. */
  private tick(dt: number): void {
    // Send camera position to WASM before tick so it can extrapolate during simulation
    this.bridge.commandBuffer.setListenerPosition(this.cameraApi.x, this.cameraApi.y, 0);

    this.bridge.tick(dt);
    this.physicsApi._dispatch();
    // After the dispatch: a sensor's last exit event names the old entity.
    const processed = this.bridge.processed;
    if (processed) {
      for (const id of this.ids.advance(processed.seq, processed.tickCount)) {
        this.physicsApi._forgetEntity(id);
        this.eventBus.emit('entity:released', id);
      }
    }
    const state = this.bridge.latestRenderState;

    // Update SystemViews for plugin hooks.
    // preTick hooks see the *previous* frame's views (already set before tickFn runs),
    // postTick/frameEnd hooks see the *current* frame's views (set here).
    if (state) {
      this.loop.setSystemViews({
        entityCount: state.entityCount,
        transforms: state.transforms,
        bounds: state.bounds,
        texIndices: state.texIndices,
        renderMeta: state.renderMeta,
        primParams: state.primParams,
        entityIds: state.entityIds,
      });
    }

    if (state && state.entityIds && this.immediateState.count > 0) {
      this.immediateState.patchTransforms(state.transforms, state.entityIds, state.entityCount);
      this.immediateState.patchBounds(state.bounds, state.entityIds, state.entityCount);
    }
    // Quality is renderer-side only: nothing crosses the ring buffer for it.
    // In Mode A the renderer is in the render worker, reached via the bridge.
    if (this.lightingApi._needsRebuild) {
      const quality = this.lightingApi.quality;
      if (this.renderer) this.renderer.setLightingQuality(quality);
      else this.bridge.setLightingQuality?.(quality);
      this.lightingApi._clearRebuildFlag();
    }
    // An empty world renders too: the frame is the clear. Skipping it left the
    // last image on screen after the last entity was destroyed.
    if (this.renderer && state) {
      this.renderer.render(state, this.camera, dt);
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
