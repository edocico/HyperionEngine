import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrioritizedCommandQueue, BackpressuredProducer } from './backpressure';
import { RingBufferProducer, CommandType, extractUnread, PAYLOAD_SIZES } from './ring-buffer';

describe('PrioritizedCommandQueue', () => {
  it('should enqueue critical commands and never drop them', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SpawnEntity, 1);
    q.enqueue(CommandType.SpawnEntity, 2);
    q.enqueue(CommandType.DespawnEntity, 1);
    expect(q.criticalCount).toBe(3);
  });

  it('should keep only latest value per entity for overwrites', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SetPosition, 1, new Float32Array([1, 2, 3]));
    q.enqueue(CommandType.SetPosition, 1, new Float32Array([4, 5, 6]));
    expect(q.overwriteCount).toBe(1); // only latest kept
  });

  // The overwrite Map keeps each key's FIRST position on purpose: under
  // backpressure a key that could not be written this frame is drained ahead of
  // the keys that were, so every entity gets through (round-robin). Moving an
  // overwritten key to the end (tried 2026-09-26) starved the tail of any update
  // loop larger than the ring buffer, and the audio listener with it.
  it('never starves a key under backpressure: every entity and the listener get through', () => {
    const q = new PrioritizedCommandQueue();
    let budget = 0;
    const seen = new Set<number>();
    const rb = {
      tryWriteCommand(cmd: number, id: number) {
        if (budget-- <= 0) return false;
        seen.add(cmd === CommandType.SetListenerPosition ? -1 : id);
        return true;
      },
    } as any;
    for (let f = 0; f < 4; f++) {
      for (let e = 1; e <= 10; e++) q.enqueue(CommandType.SetPosition, e, new Float32Array([f, 0, 0]));
      q.enqueue(CommandType.SetListenerPosition, 0, new Float32Array([f, 0, 0]));
      budget = 6;
      q.drainTo(rb);
    }
    for (let e = 1; e <= 10; e++) expect(seen.has(e), `entity ${e}`).toBe(true);
    expect(seen.has(-1), 'listener').toBe(true);
  });

  // Where call order DOES matter — two command types writing the same state —
  // the newer one replaces the pending older one, so there is nothing to order.
  function drainAll(q: PrioritizedCommandQueue): Array<{ cmd: number; id: number; first: number }> {
    const out: Array<{ cmd: number; id: number; first: number }> = [];
    q.drainTo({
      tryWriteCommand(cmd: number, id: number, payload?: Float32Array) {
        out.push({ cmd, id, first: payload?.[0] ?? NaN });
        return true;
      },
    } as any);
    return out;
  }

  it('a rotation replaces a pending rotation of the other form: the last call wins', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SetRotation, 1, new Float32Array([0, 0, 0, 1]));
    q.enqueue(CommandType.SetRotation2D, 1, new Float32Array([0.5]));
    q.enqueue(CommandType.SetRotation, 1, new Float32Array([0.7, 0, 0, 0.714]));
    expect(drainAll(q).map((d) => [d.cmd, d.first])).toEqual([[CommandType.SetRotation, expect.closeTo(0.7)]]);

    q.enqueue(CommandType.SetRotation, 2, new Float32Array([0, 0, 0, 1]));
    q.enqueue(CommandType.SetRotation2D, 2, new Float32Array([0.5]));
    expect(drainAll(q).map((d) => d.cmd)).toEqual([CommandType.SetRotation2D]);
  });

  it('a teleport replaces the pending position and rotations of its entity, and a later position still follows it', () => {
    // TeleportBody is critical, so it drains before every overwrite: without
    // this, position(p).teleport(t) reached WASM as [teleport, position] and
    // the body ended at p.
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SetPosition, 1, new Float32Array([100, 50, 0]));
    q.enqueue(CommandType.SetRotation2D, 1, new Float32Array([1.2]));
    q.enqueue(CommandType.SetPosition, 2, new Float32Array([7, 7, 0]));
    q.enqueue(CommandType.TeleportBody, 1, new Float32Array([0, 0, 0, 1]));
    expect(drainAll(q).map((d) => [d.cmd, d.id])).toEqual([
      [CommandType.TeleportBody, 1],
      [CommandType.SetPosition, 2],
    ]);

    q.enqueue(CommandType.TeleportBody, 1, new Float32Array([0, 0, 0, 1]));
    q.enqueue(CommandType.SetPosition, 1, new Float32Array([100, 50, 0]));
    expect(drainAll(q).map((d) => d.cmd)).toEqual([CommandType.TeleportBody, CommandType.SetPosition]);
  });

  it('should drain critical commands before overwrites', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SetPosition, 1, new Float32Array([1, 2, 3]));
    q.enqueue(CommandType.SpawnEntity, 2);
    const drained: Array<{ cmd: number; entityId: number }> = [];
    q.drainTo({
      tryWriteCommand(cmd: number, entityId: number) {
        drained.push({ cmd, entityId });
        return true;
      },
    } as any);
    expect(drained[0].cmd).toBe(CommandType.SpawnEntity); // critical first
    expect(drained[1].cmd).toBe(CommandType.SetPosition);
  });

  it('should stop draining when tryWriteCommand returns false', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SpawnEntity, 1);
    q.enqueue(CommandType.SpawnEntity, 2);
    let count = 0;
    q.drainTo({
      tryWriteCommand() { count++; return count < 2; }, // reject second
    } as any);
    expect(q.criticalCount).toBe(1); // one remains
  });

  it('should retain the latest payload when the same entity+cmd is overwritten', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SetPosition, 1, new Float32Array([1, 2, 3]));
    q.enqueue(CommandType.SetPosition, 1, new Float32Array([4, 5, 6]));
    const received: Float32Array[] = [];
    q.drainTo({
      tryWriteCommand(_cmd: number, _id: number, payload?: Float32Array) {
        if (payload) received.push(payload);
        return true;
      },
    } as any);
    expect(received).toHaveLength(1);
    expect(Array.from(received[0])).toEqual([4, 5, 6]);
  });

  it('should not attempt overwrites when critical commands remain unwritten', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SpawnEntity, 1);
    q.enqueue(CommandType.SetPosition, 2, new Float32Array([1, 2, 3]));
    const written: number[] = [];
    q.drainTo({
      tryWriteCommand(cmd: number) {
        written.push(cmd);
        return false; // always reject
      },
    } as any);
    expect(written).toHaveLength(1); // only the critical was attempted
    expect(q.criticalCount).toBe(1);
    expect(q.overwriteCount).toBe(1);
  });

  it('should clear after successful drain', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SpawnEntity, 1);
    q.drainTo({
      tryWriteCommand() { return true; },
    } as any);
    expect(q.criticalCount).toBe(0);
    expect(q.overwriteCount).toBe(0);
  });
});

describe('BackpressuredProducer', () => {
  const HEADER_SIZE = 32;

  function createSmallProducer(): { bp: BackpressuredProducer; sab: SharedArrayBuffer } {
    // Tiny ring buffer: 32-byte header + 64 bytes data (fits ~3 commands)
    const sab = new SharedArrayBuffer(HEADER_SIZE + 64);
    const inner = new RingBufferProducer(sab);
    const bp = new BackpressuredProducer(inner);
    return { bp, sab };
  }

  it('should pass commands through when ring buffer has space', () => {
    const { bp } = createSmallProducer();
    expect(bp.spawnEntity(1)).toBe(true);
    // Command is queued until flush
    expect(bp.pendingCount).toBe(1);
    bp.flush();
    expect(bp.pendingCount).toBe(0);
  });

  it('should queue commands when ring buffer is full', () => {
    const { bp } = createSmallProducer();
    // Queue many commands — they all go to the queue first
    for (let i = 0; i < 20; i++) {
      bp.setPosition(i, 1, 2, 3);
    }
    expect(bp.pendingCount).toBe(20);
    // Flush writes as many as fit, rest stay pending
    bp.flush();
    expect(bp.pendingCount).toBeGreaterThan(0);
  });

  it('should drain queued commands on flush', () => {
    const { bp, sab } = createSmallProducer();
    // Queue commands
    for (let i = 0; i < 20; i++) {
      bp.setPosition(i, 1, 2, 3);
    }
    // First flush writes some
    bp.flush();
    const pending = bp.pendingCount;
    expect(pending).toBeGreaterThan(0);

    // Free the ring buffer by extracting all unread bytes
    extractUnread(sab);
    bp.flush();
    expect(bp.pendingCount).toBeLessThan(pending);
  });

  it('says once per episode that a full ring buffer defers commands, never that it drops them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { bp, sab } = createSmallProducer();
      for (let i = 0; i < 20; i++) bp.setPosition(i, 1, 2, 3);
      bp.flush();
      expect(bp.pendingCount).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/deferred/);
      expect(String(warn.mock.calls[0][0])).not.toMatch(/drop/);

      // Still backed up: silent.
      bp.flush();
      expect(warn).toHaveBeenCalledTimes(1);

      // Drained, then backed up again: a new episode, one more warning.
      while (bp.pendingCount > 0) {
        extractUnread(sab);
        bp.flush();
      }
      expect(warn).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 20; i++) bp.setPosition(i, 4, 5, 6);
      bp.flush();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('should be a no-op to flush an empty queue', () => {
    const { bp } = createSmallProducer();
    const stats = bp.flush(); // nothing queued
    expect(bp.pendingCount).toBe(0);
    expect(stats.writtenCount).toBe(0);
  });

  it('keeps the 2D flag of a SpawnEntity queued under backpressure', () => {
    const { bp, sab } = createSmallProducer();
    const spawnsIn = (bytes: Uint8Array, into: Map<number, number>) => {
      for (let off = 0; off < bytes.length;) {
        const cmd = bytes[off] as CommandType;
        const id = new DataView(bytes.buffer, bytes.byteOffset + off + 1, 4).getUint32(0, true);
        if (cmd === CommandType.SpawnEntity) into.set(id, bytes[off + 5]);
        off += 5 + PAYLOAD_SIZES[cmd];
      }
    };
    for (let i = 0; i < 20; i++) bp.setPosition(i, 1, 2, 3);
    bp.flush(); // 3 positions fill 51 of the 64 bytes
    bp.spawnEntity(100, true);
    bp.spawnEntity(101, false);
    bp.spawnEntity(102, true);
    bp.flush(); // room for two 6-byte spawns: 102 waits a whole flush

    const first = new Map<number, number>();
    spawnsIn(extractUnread(sab).bytes, first);
    expect(first.has(102)).toBe(false);
    const later = new Map<number, number>();
    while (bp.pendingCount > 0) {
      bp.flush();
      spawnsIn(extractUnread(sab).bytes, later);
    }
    expect([first.get(100), first.get(101), later.get(102)]).toEqual([1, 0, 1]);
  });

  it('should expose freeSpace from inner producer', () => {
    const { bp } = createSmallProducer();
    const initial = bp.freeSpace;
    expect(initial).toBeGreaterThan(0);
    bp.spawnEntity(1);
    bp.flush(); // write the command to ring buffer
    expect(bp.freeSpace).toBeLessThan(initial);
  });

  describe('recording tap', () => {
    let producer: BackpressuredProducer;

    beforeEach(() => {
      const sab = new SharedArrayBuffer(HEADER_SIZE + 1024);
      producer = new BackpressuredProducer(new RingBufferProducer(sab));
    });

    it('invokes tap on successful direct write', () => {
      const tap = vi.fn();
      producer.setRecordingTap(tap);
      producer.spawnEntity(1);
      producer.flush();
      expect(tap).toHaveBeenCalledTimes(1);
      expect(tap).toHaveBeenCalledWith(
        1,  // CommandType.SpawnEntity
        1,  // entityId
        expect.any(Uint8Array),
      );
    });

    it('invokes tap on queued command flush', () => {
      const tap = vi.fn();
      producer.setRecordingTap(tap);
      producer.setPosition(5, 1.0, 2.0, 3.0);
      producer.flush();
      expect(tap).toHaveBeenCalledWith(
        3,  // CommandType.SetPosition
        5,
        expect.any(Uint8Array),
      );
    });

    it('does not invoke tap when tap is null', () => {
      producer.setRecordingTap(null);
      producer.spawnEntity(1);
      producer.flush();
      // No error thrown, no tap called
    });

    it('tap payload has correct byte length', () => {
      const tap = vi.fn();
      producer.setRecordingTap(tap);
      producer.setPosition(0, 1.0, 2.0, 3.0);
      producer.flush();
      const payload: Uint8Array = tap.mock.calls[0][2];
      expect(payload.byteLength).toBe(12); // 3 x f32
    });
  });
});

describe('Command coalescing', () => {
  const HEADER = 32;

  function createProducer(): { bp: BackpressuredProducer; sab: SharedArrayBuffer } {
    const sab = new SharedArrayBuffer(HEADER + 4096);
    const inner = new RingBufferProducer(sab);
    const bp = new BackpressuredProducer(inner);
    return { bp, sab };
  }

  it('last-write-wins: 3 SetPosition for same entity produces only 1 written', () => {
    const { bp, sab } = createProducer();
    bp.setPosition(1, 1, 0, 0);
    bp.setPosition(1, 2, 0, 0);
    bp.setPosition(1, 3, 0, 0);

    const stats = bp.flush();
    // Only the last value (3, 0, 0) should be written
    expect(stats.writtenCount).toBe(1);
    expect(stats.coalescedCount).toBe(2);

    // Verify the actual written data contains the last value
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBeGreaterThan(0);
    // Parse the command: 1 byte cmd + 4 bytes entityId + 12 bytes payload
    const payloadView = new DataView(bytes.buffer, bytes.byteOffset + 5, 12);
    expect(payloadView.getFloat32(0, true)).toBe(3); // last x value
  });

  it('despawn purges pending overwrites for that entity', () => {
    const { bp } = createProducer();
    bp.setPosition(1, 1, 0, 0);
    bp.setVelocity(1, 0, 1, 0);
    bp.setScale(1, 2, 2, 2);
    bp.despawnEntity(1);

    const stats = bp.flush();
    // 3 overwrites purged by despawn, only DespawnEntity written
    expect(stats.purgedByDespawn).toBe(3);
    expect(stats.writtenCount).toBe(1); // just the despawn
  });

  it('spawn and despawn bypass coalescing (ordered in critical queue)', () => {
    const { bp } = createProducer();
    bp.spawnEntity(1);
    bp.spawnEntity(2);
    bp.despawnEntity(1);

    const stats = bp.flush();
    // All 3 are lifecycle commands in the critical queue
    expect(stats.writtenCount).toBe(3);
    expect(stats.coalescedCount).toBe(0);
    expect(stats.purgedByDespawn).toBe(0);
  });

  it('different entities are not coalesced', () => {
    const { bp } = createProducer();
    bp.setPosition(1, 1, 0, 0);
    bp.setPosition(2, 2, 0, 0);
    bp.setPosition(3, 3, 0, 0);

    const stats = bp.flush();
    expect(stats.writtenCount).toBe(3);
    expect(stats.coalescedCount).toBe(0);
  });

  it('different command types on same entity are not coalesced', () => {
    const { bp } = createProducer();
    bp.setPosition(1, 1, 0, 0);
    bp.setVelocity(1, 0, 1, 0);
    bp.setScale(1, 2, 2, 2);

    const stats = bp.flush();
    expect(stats.writtenCount).toBe(3);
    expect(stats.coalescedCount).toBe(0);
  });

  it('FlushStats counters are accurate across mixed operations', () => {
    const { bp } = createProducer();
    // Entity 1: spawn + 3 positions (coalesces to 1) + despawn (purges the 1 remaining position)
    bp.spawnEntity(1);
    bp.setPosition(1, 1, 0, 0);
    bp.setPosition(1, 2, 0, 0);
    bp.setPosition(1, 3, 0, 0); // coalesces: 2 dropped during enqueue
    bp.despawnEntity(1);         // purges the 1 pending position overwrite

    // Entity 2: spawn + 2 velocities (coalesces to 1)
    bp.spawnEntity(2);
    bp.setVelocity(2, 0, 1, 0);
    bp.setVelocity(2, 0, 2, 0); // coalesces: 1 dropped during enqueue

    const stats = bp.flush();
    // Written: spawn(1) + despawn(1) + spawn(2) + velocity(2) = 4
    expect(stats.writtenCount).toBe(4);
    // Coalesced: 2 positions(entity1) + 1 velocity(entity2) = 3
    expect(stats.coalescedCount).toBe(3);
    // Purged: 1 position(entity1) purged by despawn
    expect(stats.purgedByDespawn).toBe(1);
  });

  it('recording tap fires once per flush for coalesced commands', () => {
    const { bp } = createProducer();
    const tap = vi.fn();
    bp.setRecordingTap(tap);

    bp.setPosition(1, 1, 0, 0);
    bp.setPosition(1, 2, 0, 0);
    bp.setPosition(1, 3, 0, 0);

    // Tap should NOT fire during writeCommand (commands are queued)
    expect(tap).toHaveBeenCalledTimes(0);

    bp.flush();
    // Tap fires once for the coalesced command
    expect(tap).toHaveBeenCalledTimes(1);
    expect(tap).toHaveBeenCalledWith(
      CommandType.SetPosition,
      1,
      expect.any(Uint8Array),
    );
  });
});

describe('physics command coalescing', () => {
  it('should NOT coalesce ApplyForce (both forces must execute)', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.ApplyForce, 1, new Float32Array([0, 100]));
    queue.enqueue(CommandType.ApplyForce, 1, new Float32Array([0, 100]));
    expect(queue.criticalCount).toBe(2); // Both in critical queue
  });

  it('should coalesce SetGravityScale (last-write-wins)', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.SetGravityScale, 1, new Float32Array([1.0]));
    queue.enqueue(CommandType.SetGravityScale, 1, new Float32Array([2.0]));
    expect(queue.overwriteCount).toBe(1); // Coalesced to one
  });

  it('should treat CreateRigidBody as critical', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.CreateRigidBody, 1, new Uint8Array([0]));
    expect(queue.criticalCount).toBe(1);
  });

  it('should treat DestroyRigidBody as critical', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.DestroyRigidBody, 1);
    expect(queue.criticalCount).toBe(1);
  });

  it('should treat CreateCollider as critical', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.CreateCollider, 1, new Float32Array([0, 0, 0, 0]));
    expect(queue.criticalCount).toBe(1);
  });

  it('should treat DestroyCollider as critical', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.DestroyCollider, 1);
    expect(queue.criticalCount).toBe(1);
  });

  it('should NOT coalesce ApplyImpulse (additive)', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.ApplyImpulse, 1, new Float32Array([10, 0]));
    queue.enqueue(CommandType.ApplyImpulse, 1, new Float32Array([0, 10]));
    expect(queue.criticalCount).toBe(2);
  });

  it('should NOT coalesce ApplyTorque (additive)', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.ApplyTorque, 1, new Float32Array([5.0]));
    queue.enqueue(CommandType.ApplyTorque, 1, new Float32Array([3.0]));
    expect(queue.criticalCount).toBe(2);
  });

  it('should treat joint creation as critical', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.CreateRevoluteJoint, 1, new Float32Array([0, 0, 0, 0]));
    queue.enqueue(CommandType.CreatePrismaticJoint, 2, new Float32Array([0, 0, 0, 0]));
    queue.enqueue(CommandType.CreateFixedJoint, 3, new Float32Array([0, 0, 0, 0]));
    queue.enqueue(CommandType.CreateRopeJoint, 4, new Float32Array([0, 0, 0, 0]));
    queue.enqueue(CommandType.RemoveJoint, 5, new Float32Array([1.0]));
    expect(queue.criticalCount).toBe(5);
  });

  it('should treat ALL joint commands (33-43) as non-coalescable', () => {
    const queue = new PrioritizedCommandQueue();
    // SetJointMotor is now non-coalescable (same entity + two joints = different joint_ids)
    queue.enqueue(CommandType.SetJointMotor, 1, new Float32Array([10.0]));
    queue.enqueue(CommandType.SetJointMotor, 1, new Float32Array([20.0]));
    expect(queue.criticalCount).toBe(2);
    expect(queue.overwriteCount).toBe(0);
    // New commands: CreateSpringJoint, SetSpringParams, SetJointAnchorB, SetJointAnchorA
    queue.enqueue(CommandType.CreateSpringJoint, 2, new Float32Array([1, 2, 3]));
    queue.enqueue(CommandType.SetSpringParams, 2, new Float32Array([1, 2, 3]));
    queue.enqueue(CommandType.SetJointAnchorB, 2, new Float32Array([1, 2, 3]));
    queue.enqueue(CommandType.SetJointAnchorA, 2, new Float32Array([1, 2, 3]));
    expect(queue.criticalCount).toBe(6);
  });

  it('should coalesce SetColliderDensity (last-write-wins)', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.SetColliderDensity, 1, new Float32Array([1.0]));
    queue.enqueue(CommandType.SetColliderDensity, 1, new Float32Array([2.0]));
    expect(queue.overwriteCount).toBe(1);
  });

  it('should purge physics overrides on DespawnEntity', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.SetGravityScale, 5, new Float32Array([2.0]));
    queue.enqueue(CommandType.SetLinearDamping, 5, new Float32Array([0.5]));
    expect(queue.overwriteCount).toBe(2);
    queue.enqueue(CommandType.DespawnEntity, 5);
    expect(queue.overwriteCount).toBe(0); // Purged
  });
});

describe('BackpressuredProducer convenience methods', () => {
  const HEADER = 32;

  it('setVelocity writes SetVelocity command', () => {
    const sab = new SharedArrayBuffer(HEADER + 1024);
    const producer = new BackpressuredProducer(new RingBufferProducer(sab));
    expect(producer.setVelocity(0, 1.0, 2.0, 3.0)).toBe(true);
    producer.flush();
    const { bytes } = extractUnread(sab);
    // SetVelocity: 1 cmd + 4 entity_id + 12 payload (3 x f32) = 17 bytes
    expect(bytes.length).toBe(17);
    expect(bytes[0]).toBe(CommandType.SetVelocity);
  });

  it('setRotation writes SetRotation command', () => {
    const sab = new SharedArrayBuffer(HEADER + 1024);
    const producer = new BackpressuredProducer(new RingBufferProducer(sab));
    expect(producer.setRotation(0, 0, 0, 0, 1)).toBe(true);
    producer.flush();
    const { bytes } = extractUnread(sab);
    // SetRotation: 1 cmd + 4 entity_id + 16 payload (4 x f32) = 21 bytes
    expect(bytes.length).toBe(21);
    expect(bytes[0]).toBe(CommandType.SetRotation);
  });

  it('setScale writes SetScale command', () => {
    const sab = new SharedArrayBuffer(HEADER + 1024);
    const producer = new BackpressuredProducer(new RingBufferProducer(sab));
    expect(producer.setScale(0, 2.0, 2.0, 2.0)).toBe(true);
    producer.flush();
    const { bytes } = extractUnread(sab);
    // SetScale: 1 cmd + 4 entity_id + 12 payload (3 x f32) = 17 bytes
    expect(bytes.length).toBe(17);
    expect(bytes[0]).toBe(CommandType.SetScale);
  });

  it('setParent writes SetParent command', () => {
    const sab = new SharedArrayBuffer(HEADER + 1024);
    const producer = new BackpressuredProducer(new RingBufferProducer(sab));
    expect(producer.setParent(1, 0)).toBe(true);
    producer.flush();
    const { bytes } = extractUnread(sab);
    // SetParent: 1 cmd + 4 entity_id + 4 payload (1 x u32) = 9 bytes
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(CommandType.SetParent);
  });

  it('setPrimParams0 writes SetPrimParams0 command', () => {
    const sab = new SharedArrayBuffer(HEADER + 1024);
    const producer = new BackpressuredProducer(new RingBufferProducer(sab));
    expect(producer.setPrimParams0(1, 1.0, 2.0, 3.0, 4.0)).toBe(true);
    producer.flush();
    const { bytes } = extractUnread(sab);
    // SetPrimParams0: 1 cmd + 4 entity_id + 16 payload (4 x f32) = 21 bytes
    expect(bytes.length).toBe(21);
    expect(bytes[0]).toBe(CommandType.SetPrimParams0);
  });

  it('setPrimParams1 writes SetPrimParams1 command', () => {
    const sab = new SharedArrayBuffer(HEADER + 1024);
    const producer = new BackpressuredProducer(new RingBufferProducer(sab));
    expect(producer.setPrimParams1(1, 5.0, 6.0, 7.0, 8.0)).toBe(true);
    producer.flush();
    const { bytes } = extractUnread(sab);
    // SetPrimParams1: 1 cmd + 4 entity_id + 16 payload (4 x f32) = 21 bytes
    expect(bytes.length).toBe(21);
    expect(bytes[0]).toBe(CommandType.SetPrimParams1);
  });
});

describe('physics producer methods', () => {
  const HEADER = 32;

  function createProducer(): { bp: BackpressuredProducer; sab: SharedArrayBuffer } {
    const sab = new SharedArrayBuffer(HEADER + 4096);
    const bp = new BackpressuredProducer(new RingBufferProducer(sab));
    return { bp, sab };
  }

  it('should serialize createRigidBody', () => {
    const { bp, sab } = createProducer();
    expect(bp.createRigidBody(1, 0)).toBe(true); // dynamic
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 1 payload (bodyType u8) = 6 bytes
    expect(bytes.length).toBe(6);
    expect(bytes[0]).toBe(CommandType.CreateRigidBody);
    expect(bytes[5]).toBe(0); // dynamic
  });

  it('should serialize destroyRigidBody', () => {
    const { bp, sab } = createProducer();
    expect(bp.destroyRigidBody(1)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 0 payload = 5 bytes
    expect(bytes.length).toBe(5);
    expect(bytes[0]).toBe(CommandType.DestroyRigidBody);
  });

  it('should serialize createCollider with circle shape', () => {
    const { bp, sab } = createProducer();
    expect(bp.createCollider(1, 0, 16.0)).toBe(true); // circle, radius 16
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 16 payload = 21 bytes
    expect(bytes.length).toBe(21);
    expect(bytes[0]).toBe(CommandType.CreateCollider);
    expect(bytes[5]).toBe(0); // shapeType = circle
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 6, 4);
    expect(dv.getFloat32(0, true)).toBeCloseTo(16.0);
  });

  it('should serialize destroyCollider', () => {
    const { bp, sab } = createProducer();
    expect(bp.destroyCollider(1)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(5);
    expect(bytes[0]).toBe(CommandType.DestroyCollider);
  });

  it('should serialize setLinearDamping', () => {
    const { bp, sab } = createProducer();
    expect(bp.setLinearDamping(1, 0.5)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 4 payload (1 x f32) = 9 bytes
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(CommandType.SetLinearDamping);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 4);
    expect(dv.getFloat32(0, true)).toBeCloseTo(0.5);
  });

  it('should serialize setAngularDamping', () => {
    const { bp, sab } = createProducer();
    expect(bp.setAngularDamping(1, 0.3)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(CommandType.SetAngularDamping);
  });

  it('should serialize setGravityScale', () => {
    const { bp, sab } = createProducer();
    expect(bp.setGravityScale(1, 2.0)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(CommandType.SetGravityScale);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 4);
    expect(dv.getFloat32(0, true)).toBeCloseTo(2.0);
  });

  it('should serialize setCCDEnabled', () => {
    const { bp, sab } = createProducer();
    expect(bp.setCCDEnabled(1, true)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 1 payload (u8) = 6 bytes
    expect(bytes.length).toBe(6);
    expect(bytes[0]).toBe(CommandType.SetCCDEnabled);
    expect(bytes[5]).toBe(1); // enabled
  });

  it('should serialize applyForce', () => {
    const { bp, sab } = createProducer();
    bp.applyForce(1, 100, 200);
    bp.applyForce(1, 50, 0);
    expect(bp.pendingCount).toBe(2); // NOT coalesced (additive)
    bp.flush();
    const { bytes } = extractUnread(sab);
    // Two commands: 2 * (1 cmd + 4 entity_id + 8 payload) = 2 * 13 = 26 bytes
    expect(bytes.length).toBe(26);
    expect(bytes[0]).toBe(CommandType.ApplyForce);
    expect(bytes[13]).toBe(CommandType.ApplyForce);
  });

  it('should serialize applyImpulse', () => {
    const { bp, sab } = createProducer();
    expect(bp.applyImpulse(1, 10, 20)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 8 payload (2 x f32) = 13 bytes
    expect(bytes.length).toBe(13);
    expect(bytes[0]).toBe(CommandType.ApplyImpulse);
  });

  it('should serialize applyTorque', () => {
    const { bp, sab } = createProducer();
    expect(bp.applyTorque(1, 5.0)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 4 payload (1 x f32) = 9 bytes
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(CommandType.ApplyTorque);
  });

  it('should serialize setColliderSensor', () => {
    const { bp, sab } = createProducer();
    expect(bp.setColliderSensor(1, true)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(6);
    expect(bytes[0]).toBe(CommandType.SetColliderSensor);
    expect(bytes[5]).toBe(1);
  });

  it('should serialize setColliderDensity', () => {
    const { bp, sab } = createProducer();
    expect(bp.setColliderDensity(1, 2.5)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(CommandType.SetColliderDensity);
  });

  it('should serialize setColliderRestitution', () => {
    const { bp, sab } = createProducer();
    expect(bp.setColliderRestitution(1, 0.8)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(CommandType.SetColliderRestitution);
  });

  it('should serialize setColliderFriction', () => {
    const { bp, sab } = createProducer();
    expect(bp.setColliderFriction(1, 0.4)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(CommandType.SetColliderFriction);
  });

  it('should serialize setCollisionGroups', () => {
    const { bp, sab } = createProducer();
    expect(bp.setCollisionGroups(1, 0x0001, 0xFFFF)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 4 payload (2 x u16) = 9 bytes
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(CommandType.SetCollisionGroups);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 4);
    expect(dv.getUint16(0, true)).toBe(0x0001); // membership
    expect(dv.getUint16(2, true)).toBe(0xFFFF); // filter
  });

  it('joint_handle_branded_type: createRevoluteJoint returns correct JointHandle shape', () => {
    const { bp } = createProducer();
    const joint = bp.createRevoluteJoint(10, 20, 1.5, 2.5);
    expect(joint.__brand).toBe('JointHandle');
    expect(joint._entityA).toBe(10);
    expect(typeof joint._jointId).toBe('number');
    expect(joint._jointId).toBeGreaterThan(0);
  });

  it('joint_id_monotonic: sequential creates produce incrementing IDs', () => {
    const { bp } = createProducer();
    const j1 = bp.createRevoluteJoint(1, 2, 0, 0);
    const j2 = bp.createFixedJoint(3, 4);
    const j3 = bp.createSpringJoint(5, 6, 10);
    expect(j2._jointId).toBe(j1._jointId + 1);
    expect(j3._jointId).toBe(j2._jointId + 1);
  });

  it('createRevoluteJoint_serialization: verify ring buffer bytes (16B payload)', () => {
    const { bp, sab } = createProducer();
    const joint = bp.createRevoluteJoint(10, 20, 1.5, 2.5);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 16 payload = 21 bytes
    expect(bytes.length).toBe(21);
    expect(bytes[0]).toBe(CommandType.CreateRevoluteJoint);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 16);
    expect(dv.getUint32(0, true)).toBe(joint._jointId);
    expect(dv.getUint32(4, true)).toBe(20); // entityB
    expect(dv.getFloat32(8, true)).toBeCloseTo(1.5);
    expect(dv.getFloat32(12, true)).toBeCloseTo(2.5);
    // entity_id in header is entityA
    const headerDv = new DataView(bytes.buffer, bytes.byteOffset + 1, 4);
    expect(headerDv.getUint32(0, true)).toBe(10);
  });

  it('createFixedJoint_serialization: verify 8B payload', () => {
    const { bp, sab } = createProducer();
    const joint = bp.createFixedJoint(5, 6);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 8 payload = 13 bytes
    expect(bytes.length).toBe(13);
    expect(bytes[0]).toBe(CommandType.CreateFixedJoint);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 8);
    expect(dv.getUint32(0, true)).toBe(joint._jointId);
    expect(dv.getUint32(4, true)).toBe(6); // entityB
  });

  it('removeJoint_serialization: verify 4B payload', () => {
    const { bp, sab } = createProducer();
    const joint = bp.createRevoluteJoint(10, 20, 0, 0);
    bp.flush();
    // Clear previous write
    extractUnread(sab);
    bp.removeJoint(joint);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 4 payload = 9 bytes
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(CommandType.RemoveJoint);
    const headerDv = new DataView(bytes.buffer, bytes.byteOffset + 1, 4);
    expect(headerDv.getUint32(0, true)).toBe(10); // entityA from joint
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 4);
    expect(dv.getUint32(0, true)).toBe(joint._jointId);
  });

  it('setJointMotor_serialization: verify 12B payload', () => {
    const { bp, sab } = createProducer();
    const joint = bp.createRevoluteJoint(7, 8, 0, 0);
    bp.flush();
    extractUnread(sab);
    bp.setJointMotor(joint, 3.14, 100.0);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 12 payload = 17 bytes
    expect(bytes.length).toBe(17);
    expect(bytes[0]).toBe(CommandType.SetJointMotor);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 12);
    expect(dv.getUint32(0, true)).toBe(joint._jointId);
    expect(dv.getFloat32(4, true)).toBeCloseTo(3.14);
    expect(dv.getFloat32(8, true)).toBeCloseTo(100.0);
  });
});

describe('character controller commands', () => {
  const HEADER = 32;

  function createProducer(): { bp: BackpressuredProducer; sab: SharedArrayBuffer } {
    const sab = new SharedArrayBuffer(HEADER + 4096);
    const bp = new BackpressuredProducer(new RingBufferProducer(sab));
    return { bp, sab };
  }

  it('CreateCharacterController (44) is non-coalescable — two calls produce two commands', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.CreateCharacterController, 1, new Uint8Array([0]));
    queue.enqueue(CommandType.CreateCharacterController, 1, new Uint8Array([0]));
    expect(queue.criticalCount).toBe(2);
    expect(queue.overwriteCount).toBe(0);
  });

  it('SetCharacterConfig (45) is coalescable — two calls produce one command', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.SetCharacterConfig, 1, new Uint8Array(16));
    queue.enqueue(CommandType.SetCharacterConfig, 1, new Uint8Array(16));
    expect(queue.overwriteCount).toBe(1);
    expect(queue.criticalCount).toBe(0);
  });

  it('MoveCharacter (46) is coalescable — two calls produce one command', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.MoveCharacter, 1, new Uint8Array(8));
    queue.enqueue(CommandType.MoveCharacter, 1, new Uint8Array(8));
    expect(queue.overwriteCount).toBe(1);
    expect(queue.criticalCount).toBe(0);
  });

  it('createCharacterController serializes 1B payload and writes correct command type', () => {
    const { bp, sab } = createProducer();
    bp.createCharacterController(1);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 1 payload = 6 bytes
    expect(bytes.length).toBe(6);
    expect(bytes[0]).toBe(CommandType.CreateCharacterController);
    expect(bytes[5]).toBe(0);
  });

  it('setCharacterConfig serializes 16B payload and writes correct command type', () => {
    const { bp, sab } = createProducer();
    bp.setCharacterConfig(1, { slide: true });
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 16 payload = 21 bytes
    expect(bytes.length).toBe(21);
    expect(bytes[0]).toBe(CommandType.SetCharacterConfig);
    // slide=true sets bit 0x01 in flags byte
    expect(bytes[5] & 0x01).toBe(1);
  });

  it('setCharacterConfig slide=false clears the slide flag', () => {
    const { bp, sab } = createProducer();
    bp.setCharacterConfig(1, { slide: false });
    bp.flush();
    const { bytes } = extractUnread(sab);
    expect(bytes[0]).toBe(CommandType.SetCharacterConfig);
    expect(bytes[5] & 0x01).toBe(0);
  });

  it('moveCharacter serializes dx/dy as two f32 (8B payload)', () => {
    const { bp, sab } = createProducer();
    bp.moveCharacter(1, 1.5, -2.5);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 8 payload (2 x f32) = 13 bytes
    expect(bytes.length).toBe(13);
    expect(bytes[0]).toBe(CommandType.MoveCharacter);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 8);
    expect(dv.getFloat32(0, true)).toBeCloseTo(1.5);
    expect(dv.getFloat32(4, true)).toBeCloseTo(-2.5);
  });

});

describe('physics debug render command (Phase 16)', () => {
  const HEADER = 32;

  function createProducer(): { bp: BackpressuredProducer; sab: SharedArrayBuffer } {
    const sab = new SharedArrayBuffer(HEADER + 4096);
    const bp = new BackpressuredProducer(new RingBufferProducer(sab));
    return { bp, sab };
  }

  it('SetPhysicsDebugRender (47) is coalescable — last write wins', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.SetPhysicsDebugRender, 0, new Uint8Array([1]));
    queue.enqueue(CommandType.SetPhysicsDebugRender, 0, new Uint8Array([0]));
    expect(queue.overwriteCount).toBe(1);
    expect(queue.criticalCount).toBe(0);
  });

  it('setPhysicsDebugRender serializes 1B payload with the enabled flag', () => {
    const { bp, sab } = createProducer();
    bp.setPhysicsDebugRender(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 1 payload = 6 bytes
    expect(bytes.length).toBe(6);
    expect(bytes[0]).toBe(CommandType.SetPhysicsDebugRender);
    expect(bytes[5]).toBe(1);
  });

  it('setPhysicsDebugRender(false) writes 0', () => {
    const { bp, sab } = createProducer();
    bp.setPhysicsDebugRender(false);
    bp.flush();
    const { bytes } = extractUnread(sab);
    expect(bytes[5]).toBe(0);
  });

  it('PAYLOAD_SIZES covers CommandType 47 with 1 byte', () => {
    expect(PAYLOAD_SIZES[CommandType.SetPhysicsDebugRender]).toBe(1);
  });
});

describe('phase 17 lighting commands (53-56)', () => {
  const HEADER = 32;

  function createProducer(): { bp: BackpressuredProducer; sab: SharedArrayBuffer } {
    const sab = new SharedArrayBuffer(HEADER + 4096);
    const bp = new BackpressuredProducer(new RingBufferProducer(sab));
    return { bp, sab };
  }

  it('all four are coalescable — one pending command per entity and type', () => {
    const queue = new PrioritizedCommandQueue();
    for (const cmd of [
      CommandType.SetLightFlags,
      CommandType.SetLightingFlags,
      CommandType.SetAmbientLight,
      CommandType.SetLightingBackend,
    ]) {
      queue.enqueue(cmd, 1, new Uint8Array([1]));
      queue.enqueue(cmd, 1, new Uint8Array([2]));
    }
    expect(queue.criticalCount).toBe(0);
    expect(queue.overwriteCount).toBe(4);
  });

  it('setLightFlags packs u8 + u8 + u16 little-endian', () => {
    const { bp, sab } = createProducer();
    bp.setLightFlags(7, 0b001, 0b10, 0xbeef);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 4 payload = 9 bytes
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(CommandType.SetLightFlags);
    expect(bytes[5]).toBe(0b001);      // lightType
    expect(bytes[6]).toBe(0b10);       // blendMode
    expect(bytes[7]).toBe(0xef);       // mask low byte first
    expect(bytes[8]).toBe(0xbe);
  });

  it('setLightFlags masks lightType to 3 bits and blendMode to 2', () => {
    const { bp, sab } = createProducer();
    // 0x7f, not 0xff: bit 7 of each byte means "preserve", so 0xff would
    // exercise that path instead of the masking one.
    bp.setLightFlags(1, 0x7f, 0x7f, 0xffff);
    bp.flush();
    const { bytes } = extractUnread(sab);
    expect(bytes[5]).toBe(0b111);
    expect(bytes[6]).toBe(0b11);
    expect(bytes[7]).toBe(0xff);
    expect(bytes[8]).toBe(0xff);
  });

  it('setLightFlags encodes null as the preserve bit', () => {
    const { bp, sab } = createProducer();
    bp.setLightFlags(1, null, null, 0x00ff);
    bp.flush();
    const { bytes } = extractUnread(sab);
    expect(bytes[5]).toBe(0x80);
    expect(bytes[6]).toBe(0x80);
    expect(bytes[7] | (bytes[8] << 8)).toBe(0x00ff);
  });

  it('setLightingFlags encodes null as the preserve bit', () => {
    const { bp, sab } = createProducer();
    bp.setLightingFlags(1, true, null);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // value bit0 set, preserve bit3 set for receivesLight
    expect(bytes[5]).toBe(0b1001);
  });

  it('setLightFlags round-trips all 16 mask bits', () => {
    for (const mask of [0x0000, 0x0001, 0x8000, 0xffff, 0xa5a5]) {
      const { bp, sab } = createProducer();
      bp.setLightFlags(1, 0, 0, mask);
      bp.flush();
      const { bytes } = extractUnread(sab);
      expect(bytes[7] | (bytes[8] << 8), `mask 0x${mask.toString(16)}`).toBe(mask);
    }
  });

  it('setLightingFlags encodes both bits independently', () => {
    const cases: Array<[boolean, boolean, number]> = [
      [false, false, 0b00],
      [true, false, 0b01],
      [false, true, 0b10],
      [true, true, 0b11],
    ];
    for (const [casts, receives, expected] of cases) {
      const { bp, sab } = createProducer();
      bp.setLightingFlags(3, casts, receives);
      bp.flush();
      const { bytes } = extractUnread(sab);
      expect(bytes.length).toBe(6);
      expect(bytes[0]).toBe(CommandType.SetLightingFlags);
      expect(bytes[5], `casts=${casts} receives=${receives}`).toBe(expected);
    }
  });

  it('setAmbientLight writes 4 f32 against entity 0', () => {
    const { bp, sab } = createProducer();
    bp.setAmbientLight(0.25, 0.5, 0.75, 2);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 16 payload = 21 bytes
    expect(bytes.length).toBe(21);
    expect(bytes[0]).toBe(CommandType.SetAmbientLight);
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    expect(dv.getUint32(1, true)).toBe(0); // engine-level sentinel
    expect(dv.getFloat32(5, true)).toBeCloseTo(0.25);
    expect(dv.getFloat32(9, true)).toBeCloseTo(0.5);
    expect(dv.getFloat32(13, true)).toBeCloseTo(0.75);
    expect(dv.getFloat32(17, true)).toBeCloseTo(2);
  });

  it('setAmbientLight defaults intensity to 1', () => {
    const { bp, sab } = createProducer();
    bp.setAmbientLight(0, 0, 0);
    bp.flush();
    const { bytes } = extractUnread(sab);
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    expect(dv.getFloat32(17, true)).toBeCloseTo(1);
  });

  it('setLightingBackend writes the backend id against entity 0', () => {
    for (const backend of [0, 1, 2]) {
      const { bp, sab } = createProducer();
      bp.setLightingBackend(backend);
      bp.flush();
      const { bytes } = extractUnread(sab);
      expect(bytes.length).toBe(6);
      expect(bytes[0]).toBe(CommandType.SetLightingBackend);
      expect(bytes[5]).toBe(backend);
    }
  });

  it('despawning entity 0 does not purge pending engine-level commands', () => {
    // 55 and 56 address engine state through the `entity_id = 0` sentinel, but
    // 0 is also a valid external entity id — the purge loop used to take them
    // down as collateral, silently. Same fix covers SetListenerPosition (13).
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.SetAmbientLight, 0, new Float32Array([1, 1, 1, 1]));
    queue.enqueue(CommandType.SetLightingBackend, 0, new Uint8Array([1]));
    queue.enqueue(CommandType.SetListenerPosition, 0, new Float32Array([1, 2, 3]));
    queue.enqueue(CommandType.SetLightFlags, 0, new Uint8Array([0, 0, 0, 0]));
    expect(queue.overwriteCount).toBe(4);

    queue.enqueue(CommandType.DespawnEntity, 0);

    // The entity-scoped command goes; the three engine-level ones stay.
    expect(queue.overwriteCount).toBe(3);

    const sab = new SharedArrayBuffer(HEADER + 4096);
    const kinds: number[] = [];
    queue.drainTo(new RingBufferProducer(sab), (type) => kinds.push(type));

    expect(kinds).toContain(CommandType.SetAmbientLight);
    expect(kinds).toContain(CommandType.SetLightingBackend);
    expect(kinds).toContain(CommandType.SetListenerPosition);
    expect(kinds).not.toContain(CommandType.SetLightFlags);
  });

  // ── Partial updates through the real queue ──────────────────────────
  //
  // 53 and 54 carry "preserve" bits: a field marked preserved must keep what an
  // earlier command in the same frame set. These tests drive the real
  // BackpressuredProducer, read the bytes the ring buffer would hand to Rust,
  // and fold them with the handlers' semantics (command_processor.rs,
  // SetLightFlags / SetLightingFlags). They assert the final state, so they
  // hold whether the queue merges the payloads or forwards every one in order.

  interface LightState { type: number; blend: number; mask: number; casts: boolean; receives: boolean }

  /** Reference model of the Rust handlers for 53/54, starting from `LightFlags::default()`. */
  function foldLighting(bytes: Uint8Array, entityId: number): LightState {
    const s: LightState = { type: 0, blend: 0, mask: 0, casts: false, receives: false };
    let off = 0;
    while (off < bytes.length) {
      const cmd = bytes[off] as CommandType;
      const id = (bytes[off + 1] | (bytes[off + 2] << 8) | (bytes[off + 3] << 16) | (bytes[off + 4] << 24)) >>> 0;
      const p = bytes.subarray(off + 5, off + 5 + PAYLOAD_SIZES[cmd]);
      if (id === entityId && cmd === CommandType.SetLightFlags) {
        if (!(p[0] & 0x80)) s.type = p[0] & 0b111;
        if (!(p[1] & 0x80)) s.blend = p[1] & 0b11;
        s.mask = p[2] | (p[3] << 8);
      } else if (id === entityId && cmd === CommandType.SetLightingFlags) {
        if (!(p[0] & 0b0100)) s.casts = (p[0] & 0b01) !== 0;
        if (!(p[0] & 0b1000)) s.receives = (p[0] & 0b10) !== 0;
      }
      off += 5 + PAYLOAD_SIZES[cmd];
    }
    return s;
  }

  it('castsShadow then receivesLight in one frame: both survive', () => {
    // EntityHandle.castsShadow(true).receivesLight(true) — design §11's wall.
    const { bp, sab } = createProducer();
    bp.setLightingFlags(7, true, null);
    bp.setLightingFlags(7, null, true);
    bp.flush();
    const s = foldLighting(extractUnread(sab).bytes, 7);
    expect(s.casts).toBe(true);
    expect(s.receives).toBe(true);
  });

  it('a preserved flag keeps the earlier explicit value, not the default', () => {
    const { bp, sab } = createProducer();
    bp.setLightingFlags(7, true, true);
    bp.setLightingFlags(7, null, false);
    bp.flush();
    const s = foldLighting(extractUnread(sab).bytes, 7);
    expect(s.casts).toBe(true);
    expect(s.receives).toBe(false);
  });

  it('three partial SetLightingFlags in one frame compose in order', () => {
    const { bp, sab } = createProducer();
    bp.setLightingFlags(7, null, true);
    bp.setLightingFlags(7, false, null);
    bp.setLightingFlags(7, true, null);
    bp.flush();
    const s = foldLighting(extractUnread(sab).bytes, 7);
    expect(s.casts).toBe(true);
    expect(s.receives).toBe(true);
  });

  it('light() then lightLayers() in one frame keeps the shape and blend', () => {
    // .light({ type, blend }) followed by .lightLayers(mask) on the same handle.
    const { bp, sab } = createProducer();
    bp.setLightFlags(7, 2, 3, 0xffff);
    bp.setLightFlags(7, null, null, 0x0003);
    bp.flush();
    const s = foldLighting(extractUnread(sab).bytes, 7);
    expect(s.type).toBe(2);
    expect(s.blend).toBe(3);
    expect(s.mask).toBe(0x0003);
  });

  it('a lighting flag every command in the frame preserves keeps the previous frame value', () => {
    // A merge that copies prev's value bit but drops its preserve bit would turn
    // "leave receivesLight alone" into an explicit false and clear frame 1's true.
    const { bp, sab } = createProducer();
    bp.setLightingFlags(7, null, true);
    bp.flush();
    bp.setLightingFlags(7, true, null);
    bp.setLightingFlags(7, false, null);
    bp.flush();
    const s = foldLighting(extractUnread(sab).bytes, 7);
    expect(s.casts).toBe(false);
    expect(s.receives).toBe(true);
  });

  it('a light shape every command in the frame preserves keeps the previous frame value', () => {
    const { bp, sab } = createProducer();
    bp.setLightFlags(7, 2, 3, 0xffff);
    bp.flush();
    bp.setLightFlags(7, null, null, 0x0001);
    bp.setLightFlags(7, null, null, 0x0002);
    bp.flush();
    const s = foldLighting(extractUnread(sab).bytes, 7);
    expect(s.type).toBe(2);
    expect(s.blend).toBe(3);
    expect(s.mask).toBe(0x0002);
  });

  it('an explicit SetLightFlags after a preserving one wins outright', () => {
    // Guard for the fix: merging must never let the older payload beat a newer explicit field.
    const { bp, sab } = createProducer();
    bp.setLightFlags(7, null, null, 5);
    bp.setLightFlags(7, 1, 0, 7);
    bp.flush();
    const s = foldLighting(extractUnread(sab).bytes, 7);
    expect(s.type).toBe(1);
    expect(s.blend).toBe(0);
    expect(s.mask).toBe(7);
  });
});

describe('entity id reuse support (step 1b)', () => {
  const HEADER_SIZE = 32;
  const UNPARENT = 0xFFFFFFFF;

  function producer(capacity = 1024): { bp: BackpressuredProducer; sab: SharedArrayBuffer } {
    const sab = new SharedArrayBuffer(HEADER_SIZE + capacity);
    return { bp: new BackpressuredProducer(new RingBufferProducer(sab)), sab };
  }

  /** Every command a flush wrote, as [type, entityId, first payload u32]. */
  function written(bp: BackpressuredProducer): [number, number, number | undefined][] {
    const out: [number, number, number | undefined][] = [];
    bp.setRecordingTap((type, entityId, payload) => {
      out.push([type, entityId, payload.byteLength >= 4
        ? new DataView(payload.buffer, payload.byteOffset).getUint32(0, true)
        : undefined]);
    });
    return out;
  }

  it('reports a DespawnEntity when it is written, not when it is enqueued', () => {
    const { bp } = producer();
    const onWritten = vi.fn();
    bp.setDespawnWrittenListener(onWritten);
    bp.despawnEntity(7);
    expect(onWritten).not.toHaveBeenCalled();
    bp.flush();
    expect(onWritten).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('a despawn held back by a full ring buffer is reported only when it is written', () => {
    const { bp, sab } = producer(64);
    const onWritten = vi.fn();
    bp.setDespawnWrittenListener(onWritten);
    for (let i = 0; i < 20; i++) bp.spawnEntity(100 + i);
    bp.despawnEntity(7);

    let flushes = 0;
    while (onWritten.mock.calls.length === 0 && flushes < 10) {
      bp.flush();
      flushes++;
      if (onWritten.mock.calls.length === 0) extractUnread(sab); // the consumer frees space
    }
    expect(flushes).toBeGreaterThan(1);
    expect(onWritten).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('despawning X drops a pending SetParent that points at X', () => {
    const { bp } = producer();
    const out = written(bp);
    bp.setParent(5, 7);
    bp.despawnEntity(7);
    bp.flush();
    expect(out.filter(([type]) => type === CommandType.SetParent)).toEqual([]);
  });

  it('a SetParent re-pointed at another parent survives the despawn of the first', () => {
    const { bp } = producer();
    const out = written(bp);
    bp.setParent(5, 7);
    bp.setParent(5, 8);
    bp.despawnEntity(7);
    bp.flush();
    expect(out.filter(([type]) => type === CommandType.SetParent)).toEqual([[CommandType.SetParent, 5, 8]]);
  });

  it('a SetParent to a blocked id is dropped at enqueue; unparent and live parents pass', () => {
    const { bp } = producer();
    const out = written(bp);
    bp.setReferenceGuard((id) => id !== 7);
    expect(bp.setParent(5, 7)).toBe(false);
    expect(bp.setParent(6, UNPARENT)).toBe(true);
    expect(bp.setParent(9, 8)).toBe(true);
    bp.flush();
    expect(out.map(([, entityId, parent]) => [entityId, parent])).toEqual([[6, UNPARENT], [9, 8]]);
  });
});
