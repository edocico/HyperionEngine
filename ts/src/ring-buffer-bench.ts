import { RingBufferProducer } from './ring-buffer';
import { BackpressuredProducer } from './backpressure';

const HEADER_SIZE = 32;
const WRITE_HEAD_I32 = 0;
const READ_HEAD_I32 = 1;

export interface BenchConfig {
  entityCount: number;
  frames: number;
  movingFraction: number; // 0-1, fraction of entities that move each frame
}

export interface SaturationReport {
  avgCommandsPerFrame: number;
  peakUtilizationPercent: number;
  avgFlushTimeMs: number;
  verdict: 'no-action' | 'monitor' | 'optimize';
}

/**
 * Measures ring buffer saturation under synthetic load.
 *
 * Spawns `entityCount` entities, then simulates `frames` frames where
 * `movingFraction` of entities emit SetPosition (and every 3rd also SetVelocity).
 * Between frames, simulates consumer drain by advancing readHead to writeHead.
 *
 * The `sab` parameter is the SharedArrayBuffer backing the ring buffer. It is
 * needed to simulate consumer drain (advance readHead atomically) and to
 * measure utilization directly from the header.
 *
 * Returns utilization metrics and a verdict:
 * - peakUtilization < 30% -> 'no-action'
 * - peakUtilization < 70% -> 'monitor'
 * - peakUtilization >= 70% -> 'optimize'
 */
export function measureRingBufferSaturation(
  bp: BackpressuredProducer,
  sab: SharedArrayBuffer,
  config: BenchConfig,
): SaturationReport {
  const { entityCount, frames, movingFraction } = config;
  const movingCount = Math.floor(entityCount * movingFraction);
  const capacity = sab.byteLength - HEADER_SIZE;
  const header = new Int32Array(sab, 0, 8);

  // --- Phase 1: Spawn all entities ---
  for (let id = 0; id < entityCount; id++) {
    bp.spawnEntity(id);
  }
  // Drain spawn commands
  simulateDrain(header);
  bp.flush();

  // --- Phase 2: Simulate frames ---
  let totalCommands = 0;
  let peakUtilization = 0;
  let totalFlushTimeMs = 0;

  for (let frame = 0; frame < frames; frame++) {
    const t0 = performance.now();

    // Flush any queued commands from previous frame
    bp.flush();

    let commandsThisFrame = 0;

    // Each moving entity gets SetPosition; every 3rd also gets SetVelocity
    for (let i = 0; i < movingCount; i++) {
      const entityId = i; // first N entities are the "moving" ones
      bp.setPosition(entityId, Math.random(), Math.random(), 0);
      commandsThisFrame++;

      if (i % 3 === 0) {
        bp.setVelocity(entityId, Math.random() - 0.5, Math.random() - 0.5, 0);
        commandsThisFrame++;
      }
    }

    const t1 = performance.now();
    totalFlushTimeMs += (t1 - t0);
    totalCommands += commandsThisFrame;

    // Measure utilization BEFORE drain (peak usage for this frame)
    const utilization = getUtilization(header, capacity);
    if (utilization > peakUtilization) {
      peakUtilization = utilization;
    }

    // Simulate consumer drain (WASM would do this)
    simulateDrain(header);
  }

  const avgCommandsPerFrame = totalCommands / frames;
  const peakUtilizationPercent = peakUtilization * 100;
  const avgFlushTimeMs = totalFlushTimeMs / frames;

  let verdict: SaturationReport['verdict'];
  if (peakUtilizationPercent < 30) {
    verdict = 'no-action';
  } else if (peakUtilizationPercent < 70) {
    verdict = 'monitor';
  } else {
    verdict = 'optimize';
  }

  return {
    avgCommandsPerFrame,
    peakUtilizationPercent,
    avgFlushTimeMs,
    verdict,
  };
}

/**
 * Convenience factory: allocates a SharedArrayBuffer, wraps it with
 * RingBufferProducer + BackpressuredProducer, and runs the benchmark.
 *
 * @param config Benchmark configuration
 * @param bufferCapacity Data region size in bytes (default 1 MB)
 */
export function createBenchmark(
  config: BenchConfig,
  bufferCapacity: number = 1024 * 1024,
): SaturationReport {
  const sab = new SharedArrayBuffer(HEADER_SIZE + bufferCapacity);
  const rb = new RingBufferProducer(sab);
  const bp = new BackpressuredProducer(rb);
  return measureRingBufferSaturation(bp, sab, config);
}

/**
 * Simulate consumer drain: advance readHead to writeHead.
 * This is what WASM does after processing all commands in a tick.
 */
function simulateDrain(header: Int32Array): void {
  const writeHead = Atomics.load(header, WRITE_HEAD_I32);
  Atomics.store(header, READ_HEAD_I32, writeHead);
}

/**
 * Measure current ring buffer utilization as a fraction [0, 1].
 * Used bytes = (writeHead - readHead + capacity) % capacity.
 */
function getUtilization(header: Int32Array, capacity: number): number {
  const writeHead = Atomics.load(header, WRITE_HEAD_I32);
  const readHead = Atomics.load(header, READ_HEAD_I32);
  const used = (writeHead - readHead + capacity) % capacity;
  return used / capacity;
}
