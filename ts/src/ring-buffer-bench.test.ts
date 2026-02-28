import { describe, it, expect } from 'vitest';
import { createBenchmark, measureRingBufferSaturation } from './ring-buffer-bench';
import { RingBufferProducer } from './ring-buffer';
import { BackpressuredProducer } from './backpressure';

const HEADER_SIZE = 32;

describe('Ring buffer saturation benchmark', () => {
  it('10k entities, 100% moving, 600 frames — metrics are reasonable', () => {
    const report = createBenchmark({
      entityCount: 10_000,
      frames: 600,
      movingFraction: 1.0,
    });

    // With 10k entities, 100% moving:
    // Each entity gets SetPosition (17 bytes) + every 3rd gets SetVelocity (17 bytes)
    // Expected commands per frame: 10000 + ceil(10000/3) ≈ 13334
    expect(report.avgCommandsPerFrame).toBeGreaterThan(0);
    expect(report.peakUtilizationPercent).toBeGreaterThan(0);
    expect(report.avgFlushTimeMs).toBeGreaterThanOrEqual(0);
    expect(['no-action', 'monitor', 'optimize']).toContain(report.verdict);

    // Log actual numbers for visibility
    console.log('--- 100% moving benchmark ---');
    console.log(`  avgCommandsPerFrame: ${report.avgCommandsPerFrame.toFixed(1)}`);
    console.log(`  peakUtilization:     ${report.peakUtilizationPercent.toFixed(2)}%`);
    console.log(`  avgFlushTimeMs:      ${report.avgFlushTimeMs.toFixed(3)} ms`);
    console.log(`  verdict:             ${report.verdict}`);
  });

  it('10k entities, 10% moving, 600 frames — peak utilization < 50%', () => {
    const sab = new SharedArrayBuffer(HEADER_SIZE + 1024 * 1024);
    const rb = new RingBufferProducer(sab);
    const bp = new BackpressuredProducer(rb);

    const report = measureRingBufferSaturation(bp, sab, {
      entityCount: 10_000,
      frames: 600,
      movingFraction: 0.1,
    });

    // With 10% moving on a 1MB buffer, utilization should be very low
    expect(report.peakUtilizationPercent).toBeLessThan(50);

    // Log actual numbers for visibility
    console.log('--- 10% moving benchmark ---');
    console.log(`  avgCommandsPerFrame: ${report.avgCommandsPerFrame.toFixed(1)}`);
    console.log(`  peakUtilization:     ${report.peakUtilizationPercent.toFixed(2)}%`);
    console.log(`  avgFlushTimeMs:      ${report.avgFlushTimeMs.toFixed(3)} ms`);
    console.log(`  verdict:             ${report.verdict}`);
  });
});
