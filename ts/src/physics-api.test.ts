import { describe, it, expect, vi } from 'vitest';
import {
  PhysicsAPI,
  drainCollisionEvents,
  drainContactForceEvents,
} from './physics-api';

describe('drainCollisionEvents', () => {
  it('returns empty for count 0', () => {
    const buf = new ArrayBuffer(0);
    expect(drainCollisionEvents(buf, 0, 0)).toEqual([]);
  });

  it('parses 12-byte events correctly', () => {
    const buf = new ArrayBuffer(24); // 2 events
    const dv = new DataView(buf);
    // Event 0: entityA=10, entityB=20, event_type=0 (started), is_sensor=0
    dv.setUint32(0, 10, true);
    dv.setUint32(4, 20, true);
    dv.setUint8(8, 0);
    dv.setUint8(9, 0);
    // Event 1: entityA=30, entityB=40, event_type=1 (stopped), is_sensor=1
    dv.setUint32(12, 30, true);
    dv.setUint32(16, 40, true);
    dv.setUint8(20, 1);
    dv.setUint8(21, 1);

    const events = drainCollisionEvents(buf, 0, 2);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ entityA: 10, entityB: 20, started: true, isSensor: false });
    expect(events[1]).toEqual({ entityA: 30, entityB: 40, started: false, isSensor: true });
  });
});

describe('drainContactForceEvents', () => {
  it('parses 20-byte events correctly', () => {
    const buf = new ArrayBuffer(20);
    const dv = new DataView(buf);
    dv.setUint32(0, 5, true);
    dv.setUint32(4, 6, true);
    dv.setFloat32(8, 123.5, true);
    dv.setFloat32(12, 0.707, true);
    dv.setFloat32(16, -0.707, true);

    const events = drainContactForceEvents(buf, 0, 1);
    expect(events).toHaveLength(1);
    expect(events[0].entityA).toBe(5);
    expect(events[0].entityB).toBe(6);
    expect(events[0].totalForceMagnitude).toBeCloseTo(123.5);
    expect(events[0].directionX).toBeCloseTo(0.707);
    expect(events[0].directionY).toBeCloseTo(-0.707);
  });
});

describe('PhysicsAPI', () => {
  it('raycast returns null when no WASM', () => {
    const api = new PhysicsAPI();
    expect(api.raycast(0, 0, 1, 0, 100)).toBeNull();
  });

  it('queryAABB returns empty when no WASM', () => {
    const api = new PhysicsAPI();
    expect(api.queryAABB(0, 0, 10, 10)).toEqual([]);
  });

  it('queryCircle returns empty when no WASM', () => {
    const api = new PhysicsAPI();
    expect(api.queryCircle(0, 0, 10)).toEqual([]);
  });

  it('onCollisionStart fires callback on dispatch', () => {
    const api = new PhysicsAPI();
    const cb = vi.fn();
    api.onCollisionStart(cb);

    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, 1, true);
    dv.setUint32(4, 2, true);
    dv.setUint8(8, 0); // started
    dv.setUint8(9, 0); // not sensor

    (api as any)._wasm = {
      memory: { buffer: buf },
      engine_collision_events_count: () => 1,
      engine_collision_events_ptr: () => 0,
      engine_contact_force_events_count: () => 0,
      engine_contact_force_events_ptr: () => 0,
    };

    api._dispatch();
    expect(cb).toHaveBeenCalledWith(1, 2, false);
  });

  it('onCollisionEnd fires callback on dispatch', () => {
    const api = new PhysicsAPI();
    const cb = vi.fn();
    api.onCollisionEnd(cb);

    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, 3, true);
    dv.setUint32(4, 4, true);
    dv.setUint8(8, 1); // stopped
    dv.setUint8(9, 0);

    (api as any)._wasm = {
      memory: { buffer: buf },
      engine_collision_events_count: () => 1,
      engine_collision_events_ptr: () => 0,
      engine_contact_force_events_count: () => 0,
      engine_contact_force_events_ptr: () => 0,
    };

    api._dispatch();
    expect(cb).toHaveBeenCalledWith(3, 4, false);
  });

  it('onContactForce fires callback with direction', () => {
    const api = new PhysicsAPI();
    const cb = vi.fn();
    api.onContactForce(cb);

    const buf = new ArrayBuffer(20);
    const dv = new DataView(buf);
    dv.setUint32(0, 7, true);
    dv.setUint32(4, 8, true);
    dv.setFloat32(8, 50.0, true);
    dv.setFloat32(12, 1.0, true);
    dv.setFloat32(16, 0.0, true);

    (api as any)._wasm = {
      memory: { buffer: buf },
      engine_collision_events_count: () => 0,
      engine_collision_events_ptr: () => 0,
      engine_contact_force_events_count: () => 1,
      engine_contact_force_events_ptr: () => 0,
    };

    api._dispatch();
    expect(cb).toHaveBeenCalledWith(7, 8, 50.0, 1.0, 0.0);
  });

  it('unsubscribe removes callback', () => {
    const api = new PhysicsAPI();
    const cb = vi.fn();
    const unsub = api.onCollisionStart(cb);
    unsub();

    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, 1, true);
    dv.setUint32(4, 2, true);
    dv.setUint8(8, 0);
    dv.setUint8(9, 0);

    (api as any)._wasm = {
      memory: { buffer: buf },
      engine_collision_events_count: () => 1,
      engine_collision_events_ptr: () => 0,
      engine_contact_force_events_count: () => 0,
      engine_contact_force_events_ptr: () => 0,
    };

    api._dispatch();
    expect(cb).not.toHaveBeenCalled();
  });

  it('onSensorEnter filters by entity ID', () => {
    const api = new PhysicsAPI();
    const cb = vi.fn();
    api.onSensorEnter(1, cb);

    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, 1, true);  // entityA = our sensor
    dv.setUint32(4, 5, true);  // entityB
    dv.setUint8(8, 0); // started
    dv.setUint8(9, 1); // sensor

    (api as any)._wasm = {
      memory: { buffer: buf },
      engine_collision_events_count: () => 1,
      engine_collision_events_ptr: () => 0,
      engine_contact_force_events_count: () => 0,
      engine_contact_force_events_ptr: () => 0,
    };

    api._dispatch();
    expect(cb).toHaveBeenCalledWith(5); // other entity
  });

  it('onSensorEnter bidirectional check', () => {
    const api = new PhysicsAPI();
    const cb = vi.fn();
    api.onSensorEnter(5, cb); // listening on entity 5

    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, 1, true);  // entityA
    dv.setUint32(4, 5, true);  // entityB = our sensor
    dv.setUint8(8, 0);
    dv.setUint8(9, 1);

    (api as any)._wasm = {
      memory: { buffer: buf },
      engine_collision_events_count: () => 1,
      engine_collision_events_ptr: () => 0,
      engine_contact_force_events_count: () => 0,
      engine_contact_force_events_ptr: () => 0,
    };

    api._dispatch();
    expect(cb).toHaveBeenCalledWith(1); // other entity
  });

  it('destroy clears all callbacks', () => {
    const api = new PhysicsAPI();
    const cb = vi.fn();
    api.onCollisionStart(cb);
    api.onCollisionEnd(cb);
    api.onContactForce(cb as any);
    api.onSensorEnter(1, cb);
    api.onSensorExit(1, cb);

    api.destroy();

    api._dispatch();
    expect(cb).not.toHaveBeenCalled();
  });

  it('joint convenience methods delegate to producer', () => {
    const api = new PhysicsAPI();
    const mockProducer = {
      removeJoint: vi.fn(),
      setJointMotor: vi.fn(),
      setJointLimits: vi.fn(),
      setSpringParams: vi.fn(),
      setJointAnchorA: vi.fn(),
      setJointAnchorB: vi.fn(),
    };
    api._initProducer(mockProducer as any);
    const joint = { __brand: 'JointHandle' as const, _jointId: 7, _entityA: 10 };

    api.removeJoint(joint);
    expect(mockProducer.removeJoint).toHaveBeenCalledWith(joint);

    api.setJointMotor(joint, 3.14, 100);
    expect(mockProducer.setJointMotor).toHaveBeenCalledWith(joint, 3.14, 100);

    api.setJointLimits(joint, -1, 1);
    expect(mockProducer.setJointLimits).toHaveBeenCalledWith(joint, -1, 1);

    api.setSpringParams(joint, 200, 10);
    expect(mockProducer.setSpringParams).toHaveBeenCalledWith(joint, 200, 10);

    api.setJointAnchorA(joint, 5, 6);
    expect(mockProducer.setJointAnchorA).toHaveBeenCalledWith(joint, 5, 6);

    api.setJointAnchorB(joint, 7, 8);
    expect(mockProducer.setJointAnchorB).toHaveBeenCalledWith(joint, 7, 8);
  });

  it('joint convenience methods no-op without producer', () => {
    const api = new PhysicsAPI();
    const joint = { __brand: 'JointHandle' as const, _jointId: 1, _entityA: 1 };
    // Should not throw
    expect(() => api.removeJoint(joint)).not.toThrow();
    expect(() => api.setJointMotor(joint, 0, 0)).not.toThrow();
  });

  it('destroy clears producer', () => {
    const api = new PhysicsAPI();
    const mockProducer = { removeJoint: vi.fn() };
    api._initProducer(mockProducer as any);
    api.destroy();
    const joint = { __brand: 'JointHandle' as const, _jointId: 1, _entityA: 1 };
    api.removeJoint(joint); // should no-op, not throw
    expect(mockProducer.removeJoint).not.toHaveBeenCalled();
  });

  it('dispatch survives WASM call in callback', () => {
    const api = new PhysicsAPI();

    let dispatchedEntityA = -1;
    api.onCollisionStart((a, _b, _sensor) => {
      dispatchedEntityA = a;
    });

    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, 42, true);
    dv.setUint32(4, 43, true);
    dv.setUint8(8, 0);
    dv.setUint8(9, 0);

    (api as any)._wasm = {
      memory: { buffer: buf },
      engine_collision_events_count: () => 1,
      engine_collision_events_ptr: () => 0,
      engine_contact_force_events_count: () => 0,
      engine_contact_force_events_ptr: () => 0,
    };

    api._dispatch();
    expect(dispatchedEntityA).toBe(42);
  });
});
