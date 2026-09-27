// ts/src/entity-id-allocator.ts

import { MAX_EXTERNAL_ID } from './types';

/** Who holds a live id: an EntityHandle (`engine.spawn()`) or RawAPI. */
export type IdOwner = 'handle' | 'raw';

const FREE = 0;
const LIVE_HANDLE = 1;
const LIVE_RAW = 2;
const QUARANTINED = 3;

/**
 * External entity ids, reused under quarantine (design:
 * docs/plans/2026-09-27-id-reuse-design.md).
 *
 * Fresh ids come first: the counter climbs to `maxId` exactly as it did when
 * ids were never reused, so below that every id — and `state_hash`, and a
 * command tape — is independent of timing, mode and backpressure. Only then
 * are released ids handed out, oldest first.
 *
 * A freed id is released only when all three hold:
 * 1. its DespawnEntity has been WRITTEN to the ring buffer (`written`) — under
 *    backpressure it can wait in the TS queue for several frames;
 * 2. the engine has processed the tick that consumed it (`advance`'s
 *    `processedSeq`);
 * 3. a later fixed tick has run (`advance`'s `tickCount`), so Rapier's last
 *    event naming the old entity has been produced.
 *
 * A stale RAW id still aliases the new entity once reused: nothing but a
 * generation in the id could prevent that, and the protocol has no room for
 * one today. Snapshot restore, once wired to the facade, must resync this.
 */
export class EntityIdAllocator {
  readonly maxId: number;
  private next = 0;
  private state = new Uint8Array(1024);
  /** Freed ids whose DespawnEntity has not been written yet. */
  private readonly awaitingWrite = new Set<number>();
  /** Written despawns, in write order (so in `seq` order). mark = -1: not processed yet. */
  private quarantine: { id: number; seq: number; mark: number }[] = [];
  private quarantineHead = 0;
  private pool: number[] = [];
  private poolHead = 0;

  constructor(maxId: number = MAX_EXTERNAL_ID) {
    this.maxId = maxId;
  }

  /** Hands out an id: a fresh one while any remain, else the oldest released one. */
  allocate(owner: IdOwner): number {
    let id: number;
    if (this.next <= this.maxId) {
      id = this.next++;
      if (id >= this.state.length) this.grow(id);
    } else if (this.poolHead < this.pool.length) {
      id = this.pool[this.poolHead++];
      if (this.poolHead > 1024 && this.poolHead * 2 > this.pool.length) {
        this.pool = this.pool.slice(this.poolHead);
        this.poolHead = 0;
      }
    } else {
      throw new Error(
        `Entity id space exhausted: all ${this.maxId + 1} ids are live or waiting for ` +
        `their despawn to be processed.`,
      );
    }
    this.state[id] = owner === 'handle' ? LIVE_HANDLE : LIVE_RAW;
    return id;
  }

  /** Whether the next `allocate` hands out a never-used id (false: a reused one). */
  get hasFreshIds(): boolean {
    return this.next <= this.maxId;
  }

  isLive(id: number): boolean {
    const s = this.stateOf(id);
    return s === LIVE_HANDLE || s === LIVE_RAW;
  }

  isQuarantined(id: number): boolean {
    return this.stateOf(id) === QUARANTINED;
  }

  ownerOf(id: number): IdOwner | null {
    const s = this.stateOf(id);
    return s === LIVE_HANDLE ? 'handle' : s === LIVE_RAW ? 'raw' : null;
  }

  /** Puts a live id in quarantine. Returns false, and does nothing, for any other id. */
  free(id: number): boolean {
    if (!this.isLive(id)) return false;
    this.state[id] = QUARANTINED;
    this.awaitingWrite.add(id);
    return true;
  }

  /** The DespawnEntity of `id` was written: consumed once tick `seq` is processed (TickSequencer). */
  written(id: number, seq: number): void {
    if (!this.awaitingWrite.delete(id)) return;
    this.quarantine.push({ id, seq, mark: -1 });
  }

  /**
   * The engine has processed every tick up to `processedSeq`, and its fixed-tick
   * count is `tickCount`. Returns the ids released by this call, oldest first.
   */
  advance(processedSeq: number, tickCount: number): number[] {
    const released: number[] = [];
    const q = this.quarantine;
    let i = this.quarantineHead;
    // Release what an earlier call saw processed, once a later fixed tick ran.
    // Marks never decrease along the queue, so the first one not ready stops it.
    while (i < q.length && q[i].mark >= 0 && tickCount > q[i].mark) {
      const id = q[i++].id;
      this.state[id] = FREE;
      this.pool.push(id);
      released.push(id);
    }
    this.quarantineHead = i;
    // Mark what this call sees processed; it is released by a later call.
    for (let j = i; j < q.length && q[j].seq <= processedSeq; j++) {
      if (q[j].mark < 0) q[j].mark = tickCount;
    }
    if (this.quarantineHead > 1024 && this.quarantineHead * 2 > q.length) {
      this.quarantine = q.slice(this.quarantineHead);
      this.quarantineHead = 0;
    }
    return released;
  }

  private stateOf(id: number): number {
    return Number.isInteger(id) && id >= 0 && id < this.state.length ? this.state[id] : FREE;
  }

  private grow(id: number): void {
    let size = this.state.length;
    while (size <= id) size *= 2;
    const bigger = new Uint8Array(Math.min(size, this.maxId + 1));
    bigger.set(this.state);
    this.state = bigger;
  }
}
