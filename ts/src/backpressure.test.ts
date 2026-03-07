import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrioritizedCommandQueue, BackpressuredProducer } from './backpressure';
import { RingBufferProducer, CommandType, extractUnread } from './ring-buffer';

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

  it('should drain critical commands before overwrites', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SetPosition, 1, new Float32Array([1, 2, 3]));
    q.enqueue(CommandType.SpawnEntity, 2);
    const drained: Array<{ cmd: number; entityId: number }> = [];
    q.drainTo({
      writeCommand(cmd: number, entityId: number) {
        drained.push({ cmd, entityId });
        return true;
      },
    } as any);
    expect(drained[0].cmd).toBe(CommandType.SpawnEntity); // critical first
    expect(drained[1].cmd).toBe(CommandType.SetPosition);
  });

  it('should stop draining when writeCommand returns false', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SpawnEntity, 1);
    q.enqueue(CommandType.SpawnEntity, 2);
    let count = 0;
    q.drainTo({
      writeCommand() { count++; return count < 2; }, // reject second
    } as any);
    expect(q.criticalCount).toBe(1); // one remains
  });

  it('should retain the latest payload when the same entity+cmd is overwritten', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SetPosition, 1, new Float32Array([1, 2, 3]));
    q.enqueue(CommandType.SetPosition, 1, new Float32Array([4, 5, 6]));
    const received: Float32Array[] = [];
    q.drainTo({
      writeCommand(_cmd: number, _id: number, payload?: Float32Array) {
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
      writeCommand(cmd: number) {
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
      writeCommand() { return true; },
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

  it('should be a no-op to flush an empty queue', () => {
    const { bp } = createSmallProducer();
    const stats = bp.flush(); // nothing queued
    expect(bp.pendingCount).toBe(0);
    expect(stats.writtenCount).toBe(0);
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

  it('should treat MoveCharacter as critical (additive per frame)', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.MoveCharacter, 1, new Float32Array([1, 0]));
    queue.enqueue(CommandType.MoveCharacter, 1, new Float32Array([0, 1]));
    expect(queue.criticalCount).toBe(2);
  });

  it('should coalesce SetJointMotor (last-write-wins)', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.SetJointMotor, 1, new Float32Array([10.0]));
    queue.enqueue(CommandType.SetJointMotor, 1, new Float32Array([20.0]));
    expect(queue.overwriteCount).toBe(1);
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

  it('should serialize createRevoluteJoint', () => {
    const { bp, sab } = createProducer();
    expect(bp.createRevoluteJoint(1, 2, 0.5, 1.0)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 12 payload (u32 + 2 x f32) = 17 bytes
    expect(bytes.length).toBe(17);
    expect(bytes[0]).toBe(CommandType.CreateRevoluteJoint);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 12);
    expect(dv.getUint32(0, true)).toBe(2); // targetEntityId
    expect(dv.getFloat32(4, true)).toBeCloseTo(0.5); // anchorAx
    expect(dv.getFloat32(8, true)).toBeCloseTo(1.0); // anchorAy
  });

  it('should serialize createPrismaticJoint', () => {
    const { bp, sab } = createProducer();
    expect(bp.createPrismaticJoint(1, 2, 1.0, 0.0)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(17);
    expect(bytes[0]).toBe(CommandType.CreatePrismaticJoint);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 12);
    expect(dv.getUint32(0, true)).toBe(2);
    expect(dv.getFloat32(4, true)).toBeCloseTo(1.0);
    expect(dv.getFloat32(8, true)).toBeCloseTo(0.0);
  });

  it('should serialize createFixedJoint', () => {
    const { bp, sab } = createProducer();
    expect(bp.createFixedJoint(1, 2)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 4 payload (u32) = 9 bytes
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(CommandType.CreateFixedJoint);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 4);
    expect(dv.getUint32(0, true)).toBe(2);
  });

  it('should serialize createRopeJoint', () => {
    const { bp, sab } = createProducer();
    expect(bp.createRopeJoint(1, 2, 50.0)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 8 payload (u32 + f32) = 13 bytes
    expect(bytes.length).toBe(13);
    expect(bytes[0]).toBe(CommandType.CreateRopeJoint);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 8);
    expect(dv.getUint32(0, true)).toBe(2);
    expect(dv.getFloat32(4, true)).toBeCloseTo(50.0);
  });

  it('should serialize removeJoint', () => {
    const { bp, sab } = createProducer();
    expect(bp.removeJoint(1)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(5);
    expect(bytes[0]).toBe(CommandType.RemoveJoint);
  });

  it('should serialize setJointMotor', () => {
    const { bp, sab } = createProducer();
    expect(bp.setJointMotor(1, 10.0, 100.0)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 8 payload (2 x f32) = 13 bytes
    expect(bytes.length).toBe(13);
    expect(bytes[0]).toBe(CommandType.SetJointMotor);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 8);
    expect(dv.getFloat32(0, true)).toBeCloseTo(10.0);
    expect(dv.getFloat32(4, true)).toBeCloseTo(100.0);
  });

  it('should serialize setJointLimits', () => {
    const { bp, sab } = createProducer();
    expect(bp.setJointLimits(1, -1.0, 1.0)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(13);
    expect(bytes[0]).toBe(CommandType.SetJointLimits);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 8);
    expect(dv.getFloat32(0, true)).toBeCloseTo(-1.0);
    expect(dv.getFloat32(4, true)).toBeCloseTo(1.0);
  });

  it('should serialize moveCharacter', () => {
    const { bp, sab } = createProducer();
    expect(bp.moveCharacter(1, 1.0, 0.5)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 8 payload (2 x f32) = 13 bytes
    expect(bytes.length).toBe(13);
    expect(bytes[0]).toBe(CommandType.MoveCharacter);
  });

  it('should serialize setCharacterConfig', () => {
    const { bp, sab } = createProducer();
    expect(bp.setCharacterConfig(1, 0.3, 45.0, 0.1)).toBe(true);
    bp.flush();
    const { bytes } = extractUnread(sab);
    // 1 cmd + 4 entity_id + 12 payload (3 x f32) = 17 bytes
    expect(bytes.length).toBe(17);
    expect(bytes[0]).toBe(CommandType.SetCharacterConfig);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + 5, 12);
    expect(dv.getFloat32(0, true)).toBeCloseTo(0.3);
    expect(dv.getFloat32(4, true)).toBeCloseTo(45.0);
    expect(dv.getFloat32(8, true)).toBeCloseTo(0.1);
  });
});
