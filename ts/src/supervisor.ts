import {
  HEARTBEAT_W1_OFFSET,
  HEARTBEAT_W2_OFFSET,
  OVERFLOW_COUNTER_OFFSET,
} from './ring-buffer';

export interface SupervisorConfig {
  onTimeout?: (workerId: number) => void;
  onModeChange?: (from: string, to: string, reason: string) => void;
  checkIntervalMs?: number;
  maxMissedBeats?: number;
}

/**
 * Note: Currently monitors only worker 1 (ECS) heartbeat.
 * Worker 2 (render) monitoring is deferred to Phase 5 integration.
 */
export class WorkerSupervisor {
  private header: Int32Array;
  private lastHeartbeat: number = 0;
  private missedBeats: number = 0;
  private maxMissed: number;
  private onTimeout?: (workerId: number) => void;
  private timedOut = false;

  constructor(sab: SharedArrayBuffer, config: SupervisorConfig) {
    this.header = new Int32Array(sab, 0, 8); // 32-byte header = 8 i32 slots
    this.maxMissed = config.maxMissedBeats ?? 3;
    this.onTimeout = config.onTimeout;
    this.lastHeartbeat = Atomics.load(this.header, HEARTBEAT_W1_OFFSET);
  }

  check(): void {
    if (this.timedOut) return;
    const current = Atomics.load(this.header, HEARTBEAT_W1_OFFSET);
    if (current === this.lastHeartbeat) {
      this.missedBeats++;
      if (this.missedBeats >= this.maxMissed) {
        this.timedOut = true;
        this.onTimeout?.(1);
      }
    } else {
      this.missedBeats = 0;
      this.lastHeartbeat = current;
    }
  }

  reset(): void {
    this.timedOut = false;
    this.missedBeats = 0;
    this.lastHeartbeat = Atomics.load(this.header, HEARTBEAT_W1_OFFSET);
  }

  get overflowCount(): number {
    return Atomics.load(this.header, OVERFLOW_COUNTER_OFFSET);
  }

  incrementHeartbeat(workerIndex: number): void {
    const idx = workerIndex === 1 ? HEARTBEAT_W1_OFFSET : HEARTBEAT_W2_OFFSET;
    Atomics.add(this.header, idx, 1);
  }
}
