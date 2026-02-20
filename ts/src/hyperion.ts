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
import type { Renderer } from './renderer';
import { createRenderer } from './renderer';
import type { ResolvedConfig, HyperionConfig } from './types';
import { validateConfig } from './types';
import { EntityHandle } from './entity-handle';
import { EntityHandlePool } from './entity-pool';
import { GameLoop } from './game-loop';
import { Camera } from './camera';
import { LeakDetector } from './leak-detector';

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
  private readonly loop: GameLoop;
  private readonly pool: EntityHandlePool;
  private readonly leakDetector: LeakDetector;

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
    this.pool = new EntityHandlePool();
    this.leakDetector = new LeakDetector();
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
        renderer = await createRenderer(config.canvas);
      } catch {
        renderer = null;
      }
    }

    return new Hyperion(config, bridge, renderer);
  }

  /** The execution mode label (e.g., "A", "B", "C"). */
  get mode(): string {
    return this.bridge.mode;
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

    const handle = this.pool.acquire(id, this.bridge.commandBuffer);
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

  /** Start the game loop (requestAnimationFrame). */
  start(): void {
    this.checkDestroyed();
    this.loop.start();
  }

  /** Pause the game loop (frames still fire but tick is skipped). */
  pause(): void {
    this.loop.pause();
  }

  /** Resume the game loop after a pause. */
  resume(): void {
    this.loop.resume();
  }

  /**
   * Tear down all resources: stop the loop, destroy the bridge and renderer.
   * Idempotent -- calling more than once is safe.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loop.stop();
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

  /** Per-frame tick: advance the ECS then render if state is available. */
  private tick(dt: number): void {
    this.bridge.tick(dt);
    const state = this.bridge.latestRenderState;
    if (this.renderer && state && state.entityCount > 0) {
      this.renderer.render(state, this.camera);
    }
  }

  private checkDestroyed(): void {
    if (this.destroyed) throw new Error('Hyperion instance has been destroyed');
  }
}
