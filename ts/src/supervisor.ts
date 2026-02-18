export interface SupervisorConfig {
  onTimeout?: (workerId: number) => void;
  onModeChange?: (from: string, to: string, reason: string) => void;
  checkIntervalMs?: number;
  maxMissedBeats?: number;
}

const HEARTBEAT_W1_INDEX = 4; // i32 index (byte offset 16)
const HEARTBEAT_W2_INDEX = 5; // i32 index (byte offset 20)
// SUPERVISOR_FLAGS_INDEX = 6 reserved for future use (byte offset 24)
const OVERFLOW_COUNTER_INDEX = 7;

export class WorkerSupervisor {
  private header: Int32Array;
  private lastHeartbeat: number = 0;
  private missedBeats: number = 0;
  private maxMissed: number;
  private onTimeout?: (workerId: number) => void;

  constructor(sab: SharedArrayBuffer, config: SupervisorConfig) {
    this.header = new Int32Array(sab);
    this.maxMissed = config.maxMissedBeats ?? 3;
    this.onTimeout = config.onTimeout;
    this.lastHeartbeat = Atomics.load(this.header, HEARTBEAT_W1_INDEX);
  }

  check(): void {
    const current = Atomics.load(this.header, HEARTBEAT_W1_INDEX);
    if (current === this.lastHeartbeat) {
      this.missedBeats++;
      if (this.missedBeats >= this.maxMissed) {
        this.missedBeats = 0;
        this.onTimeout?.(1);
      }
    } else {
      this.missedBeats = 0;
      this.lastHeartbeat = current;
    }
  }

  get overflowCount(): number {
    return Atomics.load(this.header, OVERFLOW_COUNTER_INDEX);
  }

  incrementHeartbeat(workerIndex: number): void {
    const idx = workerIndex === 1 ? HEARTBEAT_W1_INDEX : HEARTBEAT_W2_INDEX;
    Atomics.add(this.header, idx, 1);
  }
}
