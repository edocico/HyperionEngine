import { describe, it, expect, vi } from 'vitest';
import { EntityHandle } from './entity-handle';
import { ImmediateState } from './immediate-state';
import type { BackpressuredProducer } from './backpressure';

function mockProducer(): BackpressuredProducer {
  return {
    spawnEntity: vi.fn(() => true),
    despawnEntity: vi.fn(() => true),
    setPosition: vi.fn(() => true),
    setVelocity: vi.fn(() => true),
    setRotation: vi.fn(() => true),
    setRotation2D: vi.fn(() => true),
    setScale: vi.fn(() => true),
    setDepth: vi.fn(() => true),
    setTransparent: vi.fn(() => true),
    setTextureLayer: vi.fn(() => true),
    setMeshHandle: vi.fn(() => true),
    setRenderPrimitive: vi.fn(() => true),
    setParent: vi.fn(() => true),
    setPrimParams0: vi.fn(() => true),
    setPrimParams1: vi.fn(() => true),
    writeCommand: vi.fn(() => true),
    createRigidBody: vi.fn(() => true),
    createCollider: vi.fn(() => true),
    applyForce: vi.fn(() => true),
    applyImpulse: vi.fn(() => true),
    setGravityScale: vi.fn(() => true),
    setLinearDamping: vi.fn(() => true),
    createRevoluteJoint: vi.fn((_eA: number, _eB: number, _ax: number, _ay: number) => ({
      __brand: 'JointHandle' as const, _jointId: 1, _entityA: _eA,
    })),
    createPrismaticJoint: vi.fn((_eA: number, _eB: number, _axX: number, _axY: number) => ({
      __brand: 'JointHandle' as const, _jointId: 2, _entityA: _eA,
    })),
    createFixedJoint: vi.fn((_eA: number, _eB: number) => ({
      __brand: 'JointHandle' as const, _jointId: 3, _entityA: _eA,
    })),
    createRopeJoint: vi.fn((_eA: number, _eB: number, _maxDist: number) => ({
      __brand: 'JointHandle' as const, _jointId: 4, _entityA: _eA,
    })),
    createSpringJoint: vi.fn((_eA: number, _eB: number, _restLen: number) => ({
      __brand: 'JointHandle' as const, _jointId: 5, _entityA: _eA,
    })),
    createCharacterController: vi.fn(() => true),
    setCharacterConfig: vi.fn(() => true),
    moveCharacter: vi.fn(() => true),
    // Audit 2026-07 additions
    setColliderSensor: vi.fn(() => true),
    setColliderDensity: vi.fn(() => true),
    setColliderFriction: vi.fn(() => true),
    setColliderRestitution: vi.fn(() => true),
    setCollisionGroups: vi.fn(() => true),
    setColliderEvents: vi.fn(() => true),
    teleportBody: vi.fn(() => true),
    setBoundingRadius: vi.fn(() => true),
    destroyCharacterController: vi.fn(() => true),
    setCharacterUp: vi.fn(() => true),
    // Phase 17 lighting
    setLightFlags: vi.fn(() => true),
    setLightingFlags: vi.fn(() => true),
    flush: vi.fn(),
    pendingCount: 0,
    freeSpace: 1000,
  } as unknown as BackpressuredProducer;
}

describe('EntityHandle', () => {
  it('wraps an entity ID', () => {
    const p = mockProducer();
    const h = new EntityHandle(42, p);
    expect(h.id).toBe(42);
    expect(h.alive).toBe(true);
  });

  it('fluent position returns this', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    const result = h.position(1, 2, 3);
    expect(result).toBe(h);
    expect(p.setPosition).toHaveBeenCalledWith(0, 1, 2, 3);
  });

  it('fluent velocity returns this', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    const result = h.velocity(4, 5, 6);
    expect(result).toBe(h);
    expect(p.setVelocity).toHaveBeenCalledWith(0, 4, 5, 6);
  });

  it('fluent scale returns this', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    const result = h.scale(2, 2, 2);
    expect(result).toBe(h);
    expect(p.setScale).toHaveBeenCalledWith(0, 2, 2, 2);
  });

  it('fluent rotation returns this', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    const result = h.rotation(0, 0, 0, 1);
    expect(result).toBe(h);
    expect(p.setRotation).toHaveBeenCalledWith(0, 0, 0, 0, 1);
  });

  it('rotation(angle) sends SetRotation2D for 2D rotation', () => {
    const p = mockProducer();
    const h = new EntityHandle(5, p);
    const result = h.rotation(Math.PI / 4);
    expect(result).toBe(h);
    expect(p.setRotation2D).toHaveBeenCalledWith(5, Math.PI / 4);
    expect(p.setRotation).not.toHaveBeenCalled();
  });

  it('depth(z) sends SetDepth command', () => {
    const p = mockProducer();
    const h = new EntityHandle(3, p);
    const result = h.depth(10.5);
    expect(result).toBe(h);
    expect(p.setDepth).toHaveBeenCalledWith(3, 10.5);
  });

  it('transparent() sends SetTransparent with value 1', () => {
    const p = mockProducer();
    const h = new EntityHandle(2, p);
    const result = h.transparent();
    expect(result).toBe(h);
    expect(p.setTransparent).toHaveBeenCalledWith(2, 1);
  });

  it('opaque() sends SetTransparent with value 0', () => {
    const p = mockProducer();
    const h = new EntityHandle(2, p);
    const result = h.opaque();
    expect(result).toBe(h);
    expect(p.setTransparent).toHaveBeenCalledWith(2, 0);
  });

  it('fluent texture returns this', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    const result = h.texture(123);
    expect(result).toBe(h);
    expect(p.setTextureLayer).toHaveBeenCalledWith(0, 123);
  });

  it('fluent mesh returns this', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    const result = h.mesh(5);
    expect(result).toBe(h);
    expect(p.setMeshHandle).toHaveBeenCalledWith(0, 5);
  });

  it('fluent primitive returns this', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    const result = h.primitive(2);
    expect(result).toBe(h);
    expect(p.setRenderPrimitive).toHaveBeenCalledWith(0, 2);
  });

  it('destroy sends despawn and marks dead', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    h.destroy();
    expect(p.despawnEntity).toHaveBeenCalledWith(0);
    expect(h.alive).toBe(false);
  });

  it('throws on method call after destroy', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    h.destroy();
    expect(() => h.position(1, 2, 3)).toThrow('destroyed');
  });

  it('destroy is idempotent', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    h.destroy();
    h.destroy(); // should not throw or send twice
    expect(p.despawnEntity).toHaveBeenCalledTimes(1);
  });

  it('destroy hands the handle to its release callback exactly once', () => {
    const release = vi.fn();
    const h = new EntityHandle(0, mockProducer(), undefined, release);
    h.destroy();
    h.destroy();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(h);
  });

  it('supports Symbol.dispose', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    expect(typeof h[Symbol.dispose]).toBe('function');
    h[Symbol.dispose]();
    expect(h.alive).toBe(false);
  });

  it('data() stores and retrieves plugin data', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    expect(h.data('physics')).toBeUndefined();
    const result = h.data('physics', { mass: 10 });
    expect(result).toBe(h); // fluent setter
    expect(h.data('physics')).toEqual({ mass: 10 });
  });

  it('parent() sends SetParent command', () => {
    const p = mockProducer();
    const child = new EntityHandle(1, p);
    const result = child.parent(0);
    expect(result).toBe(child);
    expect(p.setParent).toHaveBeenCalledWith(1, 0);
  });

  it('unparent() sends SetParent with MAX sentinel', () => {
    const p = mockProducer();
    const child = new EntityHandle(1, p);
    child.unparent();
    expect(p.setParent).toHaveBeenCalledWith(1, 0xFFFFFFFF);
  });

  describe('immediate mode', () => {
    it('positionImmediate sends setPosition to producer', () => {
      const p = mockProducer();
      const imm = new ImmediateState();
      const h = new EntityHandle(7, p, imm);
      const result = h.positionImmediate(10, 20, 30);
      expect(result).toBe(h); // fluent
      expect(p.setPosition).toHaveBeenCalledWith(7, 10, 20, 30);
    });

    it('positionImmediate updates immediate state', () => {
      const p = mockProducer();
      const imm = new ImmediateState();
      const h = new EntityHandle(7, p, imm);
      h.positionImmediate(10, 20, 30);
      expect(imm.has(7)).toBe(true);
      expect(imm.get(7)).toEqual([10, 20, 30]);
    });

    it('positionImmediate works without immediate state (optional)', () => {
      const p = mockProducer();
      const h = new EntityHandle(7, p); // no ImmediateState
      expect(() => h.positionImmediate(1, 2, 3)).not.toThrow();
      expect(p.setPosition).toHaveBeenCalledWith(7, 1, 2, 3);
    });

    it('clearImmediate removes override', () => {
      const p = mockProducer();
      const imm = new ImmediateState();
      const h = new EntityHandle(7, p, imm);
      h.positionImmediate(10, 20, 30);
      expect(imm.has(7)).toBe(true);
      const result = h.clearImmediate();
      expect(result).toBe(h); // fluent
      expect(imm.has(7)).toBe(false);
    });

    it('destroy clears immediate state', () => {
      const p = mockProducer();
      const imm = new ImmediateState();
      const h = new EntityHandle(7, p, imm);
      h.positionImmediate(10, 20, 30);
      expect(imm.has(7)).toBe(true);
      h.destroy();
      expect(imm.has(7)).toBe(false);
    });

    it('positionImmediate throws after destroy', () => {
      const p = mockProducer();
      const imm = new ImmediateState();
      const h = new EntityHandle(7, p, imm);
      h.destroy();
      expect(() => h.positionImmediate(1, 2, 3)).toThrow('destroyed');
    });

    it('clearImmediate throws after destroy', () => {
      const p = mockProducer();
      const imm = new ImmediateState();
      const h = new EntityHandle(7, p, imm);
      h.destroy();
      expect(() => h.clearImmediate()).toThrow('destroyed');
    });
  });

  describe('primitive params', () => {
    it('line() sets render primitive and params', () => {
      const p = mockProducer();
      const h = new EntityHandle(1, p);
      const result = h.line(0, 0, 100, 100, 2);
      expect(result).toBe(h);
      expect(p.setRenderPrimitive).toHaveBeenCalledWith(1, 1); // Line = 1
      expect(p.setPrimParams0).toHaveBeenCalledWith(1, 0, 0, 100, 100);
      expect(p.setPrimParams1).toHaveBeenCalledWith(1, 2, 0, 0, 0);
    });

    it('line() takes the width in pixels with { unit: "px" }: flag 1 in primParams[7]', () => {
      const p = mockProducer();
      const h = new EntityHandle(1, p);
      h.line(0, 0, 100, 100, 3, { unit: 'px' });
      expect(p.setPrimParams1).toHaveBeenLastCalledWith(1, 3, 0, 0, 1);
      h.line(0, 0, 100, 100, 0.2, { unit: 'world' });
      expect(p.setPrimParams1).toHaveBeenLastCalledWith(1, 0.2, 0, 0, 0);
    });

    it('gradient() sets render primitive and params', () => {
      const p = mockProducer();
      const h = new EntityHandle(1, p);
      const result = h.gradient(0, 45, [0, 1, 0, 0, 0.5, 0]);
      expect(result).toBe(h);
      expect(p.setRenderPrimitive).toHaveBeenCalledWith(1, 4); // Gradient = 4
      expect(p.setPrimParams0).toHaveBeenCalledWith(1, 0, 45, 0, 1);
      expect(p.setPrimParams1).toHaveBeenCalledWith(1, 0, 0, 0.5, 0);
    });

    it('boxShadow() sets render primitive and params', () => {
      const p = mockProducer();
      const h = new EntityHandle(1, p);
      const result = h.boxShadow(100, 80, 8, 20, 0, 0, 0, 0.5);
      expect(result).toBe(h);
      expect(p.setRenderPrimitive).toHaveBeenCalledWith(1, 5); // BoxShadow = 5
      expect(p.setPrimParams0).toHaveBeenCalledWith(1, 100, 80, 8, 20);
      expect(p.setPrimParams1).toHaveBeenCalledWith(1, 0, 0, 0, 0.5);
    });

    it('bezier() sets render primitive and params', () => {
      const p = mockProducer();
      const h = new EntityHandle(1, p);
      const result = h.bezier(0.1, 0.2, 0.5, 0.8, 0.9, 0.3, 0.05);
      expect(result).toBe(h);
      expect(p.setRenderPrimitive).toHaveBeenCalledWith(1, 3); // BezierPath = 3
      expect(p.setPrimParams0).toHaveBeenCalledWith(1, 0.1, 0.2, 0.5, 0.8);
      expect(p.setPrimParams1).toHaveBeenCalledWith(1, 0.9, 0.3, 0.05, 0);
    });

    it('bezier() throws after destroy', () => {
      const p = mockProducer();
      const h = new EntityHandle(1, p);
      h.destroy();
      expect(() => h.bezier(0, 0, 0.5, 0.5, 1, 1, 0.02)).toThrow('destroyed');
    });

    it('line() throws after destroy', () => {
      const p = mockProducer();
      const h = new EntityHandle(1, p);
      h.destroy();
      expect(() => h.line(0, 0, 100, 100, 2)).toThrow('destroyed');
    });
  });

  describe('physics methods', () => {
    it('rigidBody sends CreateRigidBody command', () => {
      const p = mockProducer();
      const h = new EntityHandle(0, p);
      const result = h.rigidBody('dynamic');
      expect(result).toBe(h);
      expect(p.createRigidBody).toHaveBeenCalledWith(0, 0);
    });

    it('rigidBody maps static to body_type 1', () => {
      const p = mockProducer();
      const h = new EntityHandle(0, p);
      h.rigidBody('static');
      expect(p.createRigidBody).toHaveBeenCalledWith(0, 1);
    });

    it('rigidBody maps kinematic to body_type 2', () => {
      const p = mockProducer();
      const h = new EntityHandle(0, p);
      h.rigidBody('kinematic');
      expect(p.createRigidBody).toHaveBeenCalledWith(0, 2);
    });

    it('collider circle sends CreateCollider', () => {
      const p = mockProducer();
      const h = new EntityHandle(0, p);
      const result = h.collider('circle', { radius: 10 });
      expect(result).toBe(h);
      expect(p.createCollider).toHaveBeenCalledWith(0, 0, 10, 0, 0);
    });

    it('collider box sends CreateCollider', () => {
      const p = mockProducer();
      const h = new EntityHandle(0, p);
      h.collider('box', { width: 32, height: 48 });
      expect(p.createCollider).toHaveBeenCalledWith(0, 1, 32, 48, 0);
    });

    it('collider capsule sends CreateCollider', () => {
      const p = mockProducer();
      const h = new EntityHandle(0, p);
      h.collider('capsule', { halfHeight: 20, radius: 5 });
      expect(p.createCollider).toHaveBeenCalledWith(0, 2, 20, 5, 0);
    });

    it('applyForce sends ApplyForce command', () => {
      const p = mockProducer();
      const h = new EntityHandle(0, p);
      const result = h.applyForce(100, -50);
      expect(result).toBe(h);
      expect(p.applyForce).toHaveBeenCalledWith(0, 100, -50);
    });

    it('applyImpulse sends ApplyImpulse command', () => {
      const p = mockProducer();
      const h = new EntityHandle(0, p);
      const result = h.applyImpulse(200, 0);
      expect(result).toBe(h);
      expect(p.applyImpulse).toHaveBeenCalledWith(0, 200, 0);
    });

    it('gravityScale sends SetGravityScale', () => {
      const p = mockProducer();
      const h = new EntityHandle(0, p);
      const result = h.gravityScale(0.5);
      expect(result).toBe(h);
      expect(p.setGravityScale).toHaveBeenCalledWith(0, 0.5);
    });

    it('linearDamping sends SetLinearDamping', () => {
      const p = mockProducer();
      const h = new EntityHandle(0, p);
      const result = h.linearDamping(0.8);
      expect(result).toBe(h);
      expect(p.setLinearDamping).toHaveBeenCalledWith(0, 0.8);
    });

    it('rigidBody throws after destroy', () => {
      const p = mockProducer();
      const h = new EntityHandle(0, p);
      h.destroy();
      expect(() => h.rigidBody('dynamic')).toThrow('destroyed');
    });

    it('collider throws after destroy', () => {
      const p = mockProducer();
      const h = new EntityHandle(0, p);
      h.destroy();
      expect(() => h.collider('circle', { radius: 5 })).toThrow('destroyed');
    });
  });

  describe('joint methods', () => {
    it('revoluteJoint returns JointHandle with correct brand and entityA', () => {
      const p = mockProducer();
      const a = new EntityHandle(10, p);
      const b = new EntityHandle(20, p);
      const joint = a.revoluteJoint(b, { anchorAx: 1, anchorAy: 2 });
      expect(joint.__brand).toBe('JointHandle');
      expect(joint._entityA).toBe(10);
      expect(p.createRevoluteJoint).toHaveBeenCalledWith(10, 20, 1, 2);
    });

    it('revoluteJoint defaults anchor to 0,0', () => {
      const p = mockProducer();
      const a = new EntityHandle(10, p);
      const b = new EntityHandle(20, p);
      a.revoluteJoint(b);
      expect(p.createRevoluteJoint).toHaveBeenCalledWith(10, 20, 0, 0);
    });

    it('prismaticJoint defaults axis to 1,0', () => {
      const p = mockProducer();
      const a = new EntityHandle(1, p);
      const b = new EntityHandle(2, p);
      const joint = a.prismaticJoint(b);
      expect(joint.__brand).toBe('JointHandle');
      expect(p.createPrismaticJoint).toHaveBeenCalledWith(1, 2, 1, 0);
    });

    it('fixedJoint returns JointHandle', () => {
      const p = mockProducer();
      const a = new EntityHandle(1, p);
      const b = new EntityHandle(2, p);
      const joint = a.fixedJoint(b);
      expect(joint.__brand).toBe('JointHandle');
      expect(p.createFixedJoint).toHaveBeenCalledWith(1, 2);
    });

    it('ropeJoint sends maxDist', () => {
      const p = mockProducer();
      const a = new EntityHandle(1, p);
      const b = new EntityHandle(2, p);
      const joint = a.ropeJoint(b, 50);
      expect(joint.__brand).toBe('JointHandle');
      expect(p.createRopeJoint).toHaveBeenCalledWith(1, 2, 50);
    });

    it('springJoint sends restLength', () => {
      const p = mockProducer();
      const a = new EntityHandle(1, p);
      const b = new EntityHandle(2, p);
      const joint = a.springJoint(b, 30);
      expect(joint.__brand).toBe('JointHandle');
      expect(p.createSpringJoint).toHaveBeenCalledWith(1, 2, 30);
    });

    it('revoluteJoint throws after destroy', () => {
      const p = mockProducer();
      const a = new EntityHandle(1, p);
      const b = new EntityHandle(2, p);
      a.destroy();
      expect(() => a.revoluteJoint(b)).toThrow('destroyed');
    });
  });

  describe('character controller methods', () => {
    it('characterController() sends CreateCharacterController and returns this', () => {
      const p = mockProducer();
      const h = new EntityHandle(5, p);
      const result = h.characterController();
      expect(result).toBe(h);
      expect(p.createCharacterController).toHaveBeenCalledWith(5);
    });

    it('characterConfig() sends SetCharacterConfig and returns this', () => {
      const p = mockProducer();
      const h = new EntityHandle(5, p);
      const config = { maxSlopeClimbAngle: Math.PI / 3 };
      const result = h.characterConfig(config);
      expect(result).toBe(h);
      expect(p.setCharacterConfig).toHaveBeenCalledWith(5, config);
    });

    it('moveCharacter() sends MoveCharacter and returns this', () => {
      const p = mockProducer();
      const h = new EntityHandle(5, p);
      const result = h.moveCharacter(10, -5);
      expect(result).toBe(h);
      expect(p.moveCharacter).toHaveBeenCalledWith(5, 10, -5);
    });

    it('characterController() throws after destroy', () => {
      const p = mockProducer();
      const h = new EntityHandle(5, p);
      h.destroy();
      expect(() => h.characterController()).toThrow('destroyed');
    });
  });
});

// ── Audit 2026-07 ──────────────────────────────────────────────
describe('EntityHandle — audit 2026-07 additions', () => {
  it('applies collider options issued with the collider itself', () => {
    // These five commands had no handler at all in Rust before the audit, and
    // options sent in the creation batch were dropped even after the handlers
    // existed — so both halves of the path are pinned here.
    const p = mockProducer();
    const h = new EntityHandle(7, p);
    h.collider('circle', {
      radius: 10,
      sensor: true,
      density: 3,
      friction: 0.1,
      restitution: 0.9,
      groups: { membership: 0x0002, filter: 0x0004 },
    });
    expect(p.createCollider).toHaveBeenCalledWith(7, 0, 10, 0, 0);
    expect(p.setColliderSensor).toHaveBeenCalledWith(7, true);
    expect(p.setColliderDensity).toHaveBeenCalledWith(7, 3);
    expect(p.setColliderFriction).toHaveBeenCalledWith(7, 0.1);
    expect(p.setColliderRestitution).toHaveBeenCalledWith(7, 0.9);
    expect(p.setCollisionGroups).toHaveBeenCalledWith(7, 0x0002, 0x0004);
  });

  it('opts a sensor into collision events automatically', () => {
    // Events are off by default; a sensor that reports nothing is useless.
    const p = mockProducer();
    new EntityHandle(1, p).collider('circle', { radius: 5, sensor: true });
    expect(p.setColliderEvents).toHaveBeenCalledWith(1, true, false);
  });

  it('leaves events off for an ordinary collider', () => {
    const p = mockProducer();
    new EntityHandle(1, p).collider('circle', { radius: 5 });
    expect(p.setColliderEvents).not.toHaveBeenCalled();
  });

  it('box takes full extents, capsule takes a half height', () => {
    const p = mockProducer();
    const h = new EntityHandle(2, p);
    h.collider('box', { width: 40, height: 60 });
    expect(p.createCollider).toHaveBeenCalledWith(2, 1, 40, 60, 0);
    h.collider('capsule', { halfHeight: 40, radius: 5 });
    expect(p.createCollider).toHaveBeenCalledWith(2, 2, 40, 5, 0);
  });

  it('exposes teleport, boundingRadius and character-controller controls', () => {
    const p = mockProducer();
    const h = new EntityHandle(3, p);
    const chained = h
      .teleport(10, 20)
      .boundingRadius(7.5)
      .characterUp(0, -1)
      .destroyCharacterController();
    expect(chained).toBe(h);
    expect(p.teleportBody).toHaveBeenCalledWith(3, 10, 20, 0, true);
    expect(p.setBoundingRadius).toHaveBeenCalledWith(3, 7.5);
    expect(p.setCharacterUp).toHaveBeenCalledWith(3, 0, -1);
    expect(p.destroyCharacterController).toHaveBeenCalledWith(3);
  });

  it('a negative bounding radius releases the override', () => {
    const p = mockProducer();
    new EntityHandle(4, p).boundingRadius(-1);
    expect(p.setBoundingRadius).toHaveBeenCalledWith(4, -1);
  });
});

describe('EntityHandle — lighting (Phase 17)', () => {
  it('light() sets primType 6 and packs colour, energy and range', () => {
    const p = mockProducer();
    const h = new EntityHandle(7, p);
    const result = h.light({ type: 'point', color: '#ff8000', energy: 2, range: 300 });

    expect(result).toBe(h);
    expect(p.setRenderPrimitive).toHaveBeenCalledWith(7, 6);
    // Energy is premultiplied at the wire boundary, not held in the API.
    const [, r, g, b, range] = (p.setPrimParams0 as any).mock.calls[0];
    expect(r).toBeCloseTo((0xff / 255) * 2, 5);
    expect(g).toBeCloseTo((0x80 / 255) * 2, 5);
    expect(b).toBeCloseTo(0, 5);
    expect(range).toBe(300);
  });

  it('keeps colour and energy separate in the API surface', () => {
    // Same product, two different (colour, energy) pairs — the API must accept
    // both and only collapse them on the way out. Premultiplying in the API
    // would make "which colour at what intensity" unrecoverable for an editor.
    const a = mockProducer();
    new EntityHandle(1, a).light({ color: [0.5, 0.5, 0.5], energy: 2 });
    const b = mockProducer();
    new EntityHandle(1, b).light({ color: [1, 1, 1], energy: 1 });
    expect((a.setPrimParams0 as any).mock.calls[0].slice(1, 4))
      .toEqual((b.setPrimParams0 as any).mock.calls[0].slice(1, 4));
  });

  it('converts spot cone angles to cosines, and gives a point light -1', () => {
    const spot = mockProducer();
    new EntityHandle(1, spot).light({ type: 'spot', innerAngle: 0, outerAngle: 60 });
    const [, innerCos, outerCos] = (spot.setPrimParams1 as any).mock.calls[0];
    expect(innerCos).toBeCloseTo(1, 5);        // cos(0)
    expect(outerCos).toBeCloseTo(0.5, 5);      // cos(60°)

    const point = mockProducer();
    new EntityHandle(1, point).light({ type: 'point' });
    const [, pInner, pOuter] = (point.setPrimParams1 as any).mock.calls[0];
    expect(pInner).toBe(-1);                   // every direction is inside
    expect(pOuter).toBe(-1);
  });

  it('maps light type and blend mode to their wire ids', () => {
    const cases: Array<[any, any, number, number]> = [
      ['point', 'add', 0, 0], ['spot', 'sub', 1, 1], ['directional', 'mix', 2, 2],
      ['global', 'add', 3, 0], ['sprite', 'add', 4, 0],
    ];
    for (const [type, blend, typeId, blendId] of cases) {
      const p = mockProducer();
      new EntityHandle(1, p).light({ type, blend, layers: 0xabcd });
      expect(p.setLightFlags, `${type}/${blend}`).toHaveBeenCalledWith(1, typeId, blendId, 0xabcd);
    }
  });

  it('defaults to a white point light on all layers', () => {
    const p = mockProducer();
    new EntityHandle(1, p).light({});
    expect(p.setLightFlags).toHaveBeenCalledWith(1, 0, 0, 0xffff);
    const [, r, g, b, range] = (p.setPrimParams0 as any).mock.calls[0];
    expect([r, g, b, range]).toEqual([1, 1, 1, 100]);
  });

  it('rejects a malformed colour instead of emitting garbage', () => {
    const p = mockProducer();
    expect(() => new EntityHandle(1, p).light({ color: '#xyz' })).toThrow(/Invalid light color/);
  });

  it('castsShadow and receivesLight do not clear each other', () => {
    // They share one command carrying both bits, so each passes null for the
    // flag it does not own. Without that, the second call would undo the first.
    const p = mockProducer();
    const h = new EntityHandle(3, p);
    h.castsShadow(true).receivesLight(true);
    expect(p.setLightingFlags).toHaveBeenNthCalledWith(1, 3, true, null);
    expect(p.setLightingFlags).toHaveBeenNthCalledWith(2, 3, null, true);
  });

  it('castsShadow/receivesLight default to enabling and accept false', () => {
    const p = mockProducer();
    const h = new EntityHandle(3, p);
    h.castsShadow();
    expect(p.setLightingFlags).toHaveBeenNthCalledWith(1, 3, true, null);
    h.receivesLight(false);
    expect(p.setLightingFlags).toHaveBeenNthCalledWith(2, 3, null, false);
  });

  it('lightLayers changes only the mask, statelessly', () => {
    const p = mockProducer();
    new EntityHandle(5, p).lightLayers(0b11);
    // null/null = preserve the stored shape and blend, so this works on any
    // handle for the entity, not just the one that called light().
    expect(p.setLightFlags).toHaveBeenCalledWith(5, null, null, 0b11);
  });

  it('shadows() preserves the cone and falloff that light() wrote', () => {
    const p = mockProducer();
    const h = new EntityHandle(9, p);
    h.light({ type: 'spot', innerAngle: 0, outerAngle: 60, falloff: 3 });
    (p.setPrimParams1 as any).mockClear();

    h.shadows(0.8);
    const [, innerCos, outerCos, falloff, intensity] = (p.setPrimParams1 as any).mock.calls[0];
    expect(innerCos).toBeCloseTo(1, 5);
    expect(outerCos).toBeCloseTo(0.5, 5);
    expect(falloff).toBe(3);
    expect(intensity).toBe(0.8);
  });

  it('every joint method throws when the target entity is destroyed', () => {
    const p = mockProducer();
    const a = new EntityHandle(1, p);
    const dead = new EntityHandle(2, p);
    dead.destroy();
    expect(() => a.revoluteJoint(dead)).toThrow(/destroyed/);
    expect(() => a.prismaticJoint(dead)).toThrow(/destroyed/);
    expect(() => a.fixedJoint(dead)).toThrow(/destroyed/);
    expect(() => a.ropeJoint(dead, 5)).toThrow(/destroyed/);
    expect(() => a.springJoint(dead, 5)).toThrow(/destroyed/);
  });

  it('every lighting method throws after destroy()', () => {
    const p = mockProducer();
    const h = new EntityHandle(1, p);
    h.destroy();
    expect(() => h.light({})).toThrow(/destroyed/);
    expect(() => h.shadows(1)).toThrow(/destroyed/);
    expect(() => h.castsShadow(true)).toThrow(/destroyed/);
    expect(() => h.receivesLight(true)).toThrow(/destroyed/);
    expect(() => h.lightLayers(1)).toThrow(/destroyed/);
  });
});

describe('EntityHandle — 2D entities (spawn({ mode: "2d" }))', () => {
  const quat = (angle: number) => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)] as const;

  it('is 3D by default; is2D when built for a 2D entity', () => {
    expect(new EntityHandle(1, mockProducer()).is2D).toBe(false);
    expect(new EntityHandle(1, mockProducer(), undefined, undefined, true).is2D).toBe(true);
  });

  it('z is optional for every handle: position/velocity default 0, scale sz 1', () => {
    const p = mockProducer();
    new EntityHandle(3, p).position(1, 2).velocity(4, 5).scale(2, 3);
    expect(p.setPosition).toHaveBeenCalledWith(3, 1, 2, 0);
    expect(p.setVelocity).toHaveBeenCalledWith(3, 4, 5, 0);
    expect(p.setScale).toHaveBeenCalledWith(3, 2, 3, 1);
  });

  it('a 2D handle warns once in dev when a 3D-only argument arrives, and still sends it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = mockProducer();
      const h = new EntityHandle(7, p, undefined, undefined, true);
      h.position(1, 2, 0).scale(2, 2, 1).velocity(1, 1, 0).rotation(...quat(0.5));
      expect(warn).not.toHaveBeenCalled();
      h.position(1, 2, 5);
      expect(p.setPosition).toHaveBeenLastCalledWith(7, 1, 2, 5); // Rust ignores z
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/2D entity 7.*position z/);
      h.scale(1, 1, 3).velocity(0, 0, 2).rotation(0.3, 0, 0, 0.95);
      expect(warn).toHaveBeenCalledTimes(1); // once per handle
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['scale sz', (h: EntityHandle) => h.scale(1, 1, 3)],
    ['velocity vz', (h: EntityHandle) => h.velocity(0, 0, 2)],
    ['a tilted quaternion', (h: EntityHandle) => h.rotation(0.3, 0, 0, 0.95)],
    ['positionImmediate z', (h: EntityHandle) => h.positionImmediate(1, 1, 4)],
  ])('a 2D handle warns for %s', (what, call) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      call(new EntityHandle(8, mockProducer(), new ImmediateState(), undefined, true));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(what);
    } finally {
      warn.mockRestore();
    }
  });

  it('a 3D handle never warns for z, sz, vz or a tilt', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      new EntityHandle(9, mockProducer()).position(1, 2, 5).scale(1, 1, 3).velocity(0, 0, 2).rotation(0.3, 0, 0, 0.95);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('positionImmediate on a 2D handle shadows z = 0, where the engine draws it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const imm = new ImmediateState();
      new EntityHandle(10, mockProducer(), imm, undefined, true).positionImmediate(1, 2, 4);
      expect(imm.get(10)).toEqual([1, 2, 0]);
    } finally {
      warn.mockRestore();
    }
  });
});
