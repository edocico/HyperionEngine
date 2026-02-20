import type { EngineBridge } from './worker-bridge';
import type { Renderer } from './renderer';
import type { ResolvedConfig } from './types';
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
 * Construct via the static `fromParts()` factory (used by `Hyperion.create()`
 * once capability detection and bridge/renderer creation are wired up).
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
   * Used for testing and by the future `Hyperion.create()` async factory.
   */
  static fromParts(
    config: ResolvedConfig,
    bridge: EngineBridge,
    renderer: Renderer | null,
  ): Hyperion {
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
