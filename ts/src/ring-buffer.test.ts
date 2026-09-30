import { describe, it, expect, vi } from "vitest";
import { RingBufferProducer, CommandType, IS_LITTLE_ENDIAN, extractUnread, PAYLOAD_SIZES } from "./ring-buffer";

const HEADER_SIZE = 32;
const CAPACITY = 256;

function makeBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_SIZE + CAPACITY);
}

function readByte(sab: SharedArrayBuffer, dataOffset: number): number {
  return new Uint8Array(sab, HEADER_SIZE)[dataOffset];
}

function readU32LE(sab: SharedArrayBuffer, dataOffset: number): number {
  const view = new DataView(sab, HEADER_SIZE);
  return view.getUint32(dataOffset, true);
}

function readF32LE(sab: SharedArrayBuffer, dataOffset: number): number {
  const view = new DataView(sab, HEADER_SIZE);
  return view.getFloat32(dataOffset, true);
}

function getWriteHead(sab: SharedArrayBuffer): number {
  return Atomics.load(new Int32Array(sab, 0, 1), 0);
}

describe("RingBufferProducer", () => {
  it("starts with full free space", () => {
    const sab = makeBuffer();
    const rb = new RingBufferProducer(sab);
    expect(rb.freeSpace).toBe(CAPACITY - 1);
  });

  it("writes a spawn command (3D default)", () => {
    const sab = makeBuffer();
    const rb = new RingBufferProducer(sab);
    const ok = rb.spawnEntity(42);
    expect(ok).toBe(true);
    expect(readByte(sab, 0)).toBe(CommandType.SpawnEntity);
    expect(readU32LE(sab, 1)).toBe(42);
    expect(readByte(sab, 5)).toBe(0); // 3D flag
    expect(getWriteHead(sab)).toBe(6); // 1 cmd + 4 entity_id + 1 payload
  });

  it("writes a spawn command with 2D flag", () => {
    const sab = makeBuffer();
    const rb = new RingBufferProducer(sab);
    const ok = rb.spawnEntity(7, true);
    expect(ok).toBe(true);
    expect(readByte(sab, 0)).toBe(CommandType.SpawnEntity);
    expect(readU32LE(sab, 1)).toBe(7);
    expect(readByte(sab, 5)).toBe(1); // 2D flag
    expect(getWriteHead(sab)).toBe(6);
  });

  it("writes a position command with f32 payload", () => {
    const sab = makeBuffer();
    const rb = new RingBufferProducer(sab);
    const ok = rb.setPosition(7, 1.0, 2.0, 3.0);
    expect(ok).toBe(true);
    expect(readByte(sab, 0)).toBe(CommandType.SetPosition);
    expect(readU32LE(sab, 1)).toBe(7);
    expect(readF32LE(sab, 5)).toBeCloseTo(1.0);
    expect(readF32LE(sab, 9)).toBeCloseTo(2.0);
    expect(readF32LE(sab, 13)).toBeCloseTo(3.0);
    expect(getWriteHead(sab)).toBe(17);
  });

  it("returns false when buffer is full", () => {
    const smallSab = new SharedArrayBuffer(HEADER_SIZE + 8);
    const rb = new RingBufferProducer(smallSab);
    const ok = rb.setPosition(1, 0, 0, 0);
    expect(ok).toBe(false);
  });

  it("tryWriteCommand returns false on a full buffer and logs nothing: the caller decides", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rb = new RingBufferProducer(new SharedArrayBuffer(HEADER_SIZE + 8));
      expect(rb.tryWriteCommand(CommandType.SetPosition, 1, new Float32Array([0, 0, 0]))).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("writeCommand says a command that does not fit is dropped: this producer has no queue", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rb = new RingBufferProducer(new SharedArrayBuffer(HEADER_SIZE + 8));
      expect(rb.writeCommand(CommandType.SetPosition, 1, new Float32Array([0, 0, 0]))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/dropped/);
    } finally {
      warn.mockRestore();
    }
  });

  it("writes multiple commands sequentially", () => {
    const sab = makeBuffer();
    const rb = new RingBufferProducer(sab);
    rb.spawnEntity(1);     // 6 bytes (1 cmd + 4 id + 1 payload)
    rb.spawnEntity(2);     // 6 bytes
    rb.despawnEntity(3);   // 5 bytes (no payload)
    expect(getWriteHead(sab)).toBe(17); // 6 + 6 + 5
  });

  it("writes SetTextureLayer command with u32 payload", () => {
    const sab = new SharedArrayBuffer(HEADER_SIZE + 128);
    const rb = new RingBufferProducer(sab);

    const packed = (2 << 16) | 10; // tier 2, layer 10
    const ok = rb.setTextureLayer(5, packed);
    expect(ok).toBe(true);

    // Message: 1 (cmd) + 4 (entity_id) + 4 (u32 payload) = 9 bytes
    const header = new Int32Array(sab, 0, 4);
    const writeHead = Atomics.load(header, 0);
    expect(writeHead).toBe(9);

    // Verify command type
    const data = new Uint8Array(sab, HEADER_SIZE, 128);
    expect(data[0]).toBe(7); // CommandType.SetTextureLayer

    // Verify entity ID = 5
    const entityId = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
    expect(entityId).toBe(5);

    // Verify packed payload
    const payload = data[5] | (data[6] << 8) | (data[7] << 16) | (data[8] << 24);
    expect(payload).toBe(packed);
  });

  it("should use 32-byte header", () => {
    const sab = makeBuffer();
    // Verify the header region is 32 bytes
    expect(sab.byteLength).toBe(HEADER_SIZE + CAPACITY);
  });

  it("writes SetMeshHandle command with u32 payload", () => {
    const sab = makeBuffer();
    const rb = new RingBufferProducer(sab);
    const ok = rb.setMeshHandle(1, 42);
    expect(ok).toBe(true);

    expect(getWriteHead(sab)).toBe(9); // 1 cmd + 4 entity_id + 4 payload
    expect(readByte(sab, 0)).toBe(CommandType.SetMeshHandle);
    expect(readU32LE(sab, 1)).toBe(1); // entity ID
    expect(readU32LE(sab, 5)).toBe(42); // mesh handle
  });

  it("writes SetRenderPrimitive command with u32 payload", () => {
    const sab = makeBuffer();
    const rb = new RingBufferProducer(sab);
    const ok = rb.setRenderPrimitive(1, 2);
    expect(ok).toBe(true);

    expect(getWriteHead(sab)).toBe(9);
    expect(readByte(sab, 0)).toBe(CommandType.SetRenderPrimitive);
    expect(readU32LE(sab, 1)).toBe(1); // entity ID
    expect(readU32LE(sab, 5)).toBe(2); // render primitive
  });

  it("should detect little-endian platform", () => {
    expect(IS_LITTLE_ENDIAN).toBe(true); // Node.js is always LE
  });

  it("should produce identical bytes with TypedArray fast path", () => {
    const sab = makeBuffer();
    const rb = new RingBufferProducer(sab);

    // Write position command (uses f32 payload fast path)
    rb.setPosition(42, 1.5, 2.5, 3.5);

    // Verify bytes are correct little-endian encoding
    const data = new Uint8Array(sab, HEADER_SIZE);
    expect(data[0]).toBe(CommandType.SetPosition); // cmd

    // entity_id = 42 in LE
    const entityId = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
    expect(entityId).toBe(42);

    // f32 payload
    const view = new DataView(sab, HEADER_SIZE);
    expect(view.getFloat32(5, true)).toBeCloseTo(1.5);
    expect(view.getFloat32(9, true)).toBeCloseTo(2.5);
    expect(view.getFloat32(13, true)).toBeCloseTo(3.5);
  });

  it("writes correctly when entity_id straddles the wrap boundary", () => {
    const cap = 32; // small capacity
    const sab = new SharedArrayBuffer(HEADER_SIZE + cap);
    const header = new Int32Array(sab, 0, 8);
    // SpawnEntity is now 6 bytes: 1 cmd + 4 entity_id + 1 payload.
    // Place writeHead at cap-4 = 28 so entity_id straddles the wrap.
    // readHead = writeHead → freeSpace = cap - 1 = 31, enough for 6 bytes.
    Atomics.store(header, 0, cap - 4); // writeHead = 28
    Atomics.store(header, 1, cap - 4); // readHead = 28 (same: all space is "free")

    const rb = new RingBufferProducer(sab);
    const ok = rb.spawnEntity(0xDEADBEEF);
    expect(ok).toBe(true);

    // After write, writeHead = (28 + 6) % 32 = 2. readHead = 28.
    // extractUnread: writeHead(2) < readHead(28) → wrap: data[28..32] + data[0..2] = 6 bytes
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(6);
    expect(bytes[0]).toBe(CommandType.SpawnEntity);
    const id = (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) >>> 0;
    expect(id).toBe(0xDEADBEEF);
    expect(bytes[5]).toBe(0); // 3D flag
  });

  it("writes correctly when f32 payload straddles the wrap boundary", () => {
    // Use a larger buffer so there's enough free space for a 17-byte command
    const cap = 64;
    const sab = new SharedArrayBuffer(HEADER_SIZE + cap);
    const header = new Int32Array(sab, 0, 8);
    // setPosition: 1 cmd + 4 entity_id + 12 payload = 17 bytes
    // writeHead = cap - 7 = 57: cmd@57, id@58-61, payload starts @62 (straddles at 62,63,0,1...)
    // Set readHead = writeHead so extractUnread returns only the newly written bytes
    Atomics.store(header, 0, cap - 7); // writeHead = 57
    Atomics.store(header, 1, cap - 7); // readHead = 57

    const rb = new RingBufferProducer(sab);
    const ok = rb.setPosition(1, 1.5, 2.5, 3.5);
    expect(ok).toBe(true);

    // After write, writeHead = (57 + 17) % 64 = 10. readHead = 57.
    // extractUnread: writeHead(10) < readHead(57) → wrap: data[57..64] + data[0..10] = 17 bytes
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(17);
    expect(bytes[0]).toBe(CommandType.SetPosition);

    // entity_id
    const id = bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24);
    expect(id).toBe(1);

    // f32 payload
    const payloadBuf = new ArrayBuffer(12);
    new Uint8Array(payloadBuf).set(bytes.slice(5, 17));
    const view = new DataView(payloadBuf);
    expect(view.getFloat32(0, true)).toBeCloseTo(1.5);
    expect(view.getFloat32(4, true)).toBeCloseTo(2.5);
    expect(view.getFloat32(8, true)).toBeCloseTo(3.5);
  });

  it("throws when capacity is not a multiple of 4", () => {
    // capacity = 33 (not a multiple of 4)
    const sab = new SharedArrayBuffer(HEADER_SIZE + 33);
    expect(() => new RingBufferProducer(sab)).toThrow(
      "RingBufferProducer: capacity must be a multiple of 4, got 33"
    );
  });

  it('should write and read SetPrimParams0 command', () => {
    const sab = makeBuffer();
    const prod = new RingBufferProducer(sab);

    const ok = prod.setPrimParams0(42, 1.0, 2.0, 3.0, 4.0);
    expect(ok).toBe(true);

    const data = extractUnread(sab);
    expect(data.bytes.byteLength).toBe(1 + 4 + 16); // cmd + entityId + 4xf32
    const view = new DataView(data.bytes.buffer, data.bytes.byteOffset);
    expect(view.getUint8(0)).toBe(11); // SetPrimParams0
    expect(view.getUint32(1, true)).toBe(42);
    expect(view.getFloat32(5, true)).toBeCloseTo(1.0);
    expect(view.getFloat32(9, true)).toBeCloseTo(2.0);
    expect(view.getFloat32(13, true)).toBeCloseTo(3.0);
    expect(view.getFloat32(17, true)).toBeCloseTo(4.0);
  });

  it('should write and read SetPrimParams1 command', () => {
    const sab = makeBuffer();
    const prod = new RingBufferProducer(sab);

    const ok = prod.setPrimParams1(42, 5.0, 6.0, 7.0, 8.0);
    expect(ok).toBe(true);

    const data = extractUnread(sab);
    const view = new DataView(data.bytes.buffer, data.bytes.byteOffset);
    expect(view.getUint8(0)).toBe(12); // SetPrimParams1
    expect(view.getUint32(1, true)).toBe(42);
    expect(view.getFloat32(5, true)).toBeCloseTo(5.0);
    expect(view.getFloat32(9, true)).toBeCloseTo(6.0);
    expect(view.getFloat32(13, true)).toBeCloseTo(7.0);
    expect(view.getFloat32(17, true)).toBeCloseTo(8.0);
  });

  it('writes and reads SetListenerPosition command', () => {
    const sab = new SharedArrayBuffer(32 + 256);
    const producer = new RingBufferProducer(sab);
    const result = producer.writeCommand(
      CommandType.SetListenerPosition,
      0,
      new Float32Array([1.5, 2.5, 3.5]),
    );
    expect(result).toBe(true);

    const data = extractUnread(sab);
    expect(data.bytes.byteLength).toBe(1 + 4 + 12); // cmd + entityId + 3xf32
    const view = new DataView(data.bytes.buffer, data.bytes.byteOffset);
    expect(view.getUint8(0)).toBe(13); // SetListenerPosition
    expect(view.getUint32(1, true)).toBe(0); // sentinel entity ID
    expect(view.getFloat32(5, true)).toBeCloseTo(1.5);
    expect(view.getFloat32(9, true)).toBeCloseTo(2.5);
    expect(view.getFloat32(13, true)).toBeCloseTo(3.5);
  });
});

describe('physics CommandTypes', () => {
  it('should have matching payload sizes for all physics commands', () => {
    // Physics commands 17-41 must all exist and have payload <= 16
    const physicsCommands = [
      CommandType.CreateRigidBody, CommandType.DestroyRigidBody,
      CommandType.CreateCollider, CommandType.DestroyCollider,
      CommandType.SetLinearDamping, CommandType.SetAngularDamping,
      CommandType.SetGravityScale, CommandType.SetCCDEnabled,
      CommandType.ApplyForce, CommandType.ApplyImpulse, CommandType.ApplyTorque,
      CommandType.SetColliderSensor, CommandType.SetColliderDensity,
      CommandType.SetColliderRestitution, CommandType.SetColliderFriction,
      CommandType.SetCollisionGroups,
      CommandType.CreateRevoluteJoint, CommandType.CreatePrismaticJoint,
      CommandType.CreateFixedJoint, CommandType.CreateRopeJoint,
      CommandType.RemoveJoint, CommandType.SetJointMotor, CommandType.SetJointLimits,
      CommandType.CreateSpringJoint, CommandType.SetSpringParams,
      CommandType.SetJointAnchorB, CommandType.SetJointAnchorA,
    ];
    expect(physicsCommands).toHaveLength(27);
    for (const cmd of physicsCommands) {
      expect(cmd).toBeGreaterThanOrEqual(17);
      expect(cmd).toBeLessThanOrEqual(43);
      expect(PAYLOAD_SIZES[cmd]).toBeLessThanOrEqual(16);
    }
  });
});

// ── Audit 2026-07: protocol extension ──────────────────────────
//
// Commands 48-52 close behaviour that had no reachable command at all.
// These tests pin the wire contract that ring_buffer.rs mirrors.
describe('audit 2026-07 command types', () => {
  it('declares payload sizes for every new command', () => {
    expect(PAYLOAD_SIZES[CommandType.SetColliderEvents]).toBe(1);
    expect(PAYLOAD_SIZES[CommandType.TeleportBody]).toBe(13);
    expect(PAYLOAD_SIZES[CommandType.SetBoundingRadius]).toBe(4);
    expect(PAYLOAD_SIZES[CommandType.DestroyCharacterController]).toBe(0);
    expect(PAYLOAD_SIZES[CommandType.SetCharacterUp]).toBe(8);
  });

  // ⚠️ Both sweeps below are bounded by this constant, and `const enum` gives
  // no way to derive it (no reverse mapping, no Object.values). Re-point it at
  // the last member every time a CommandType is added, or the new command is
  // silently excluded from both checks. Declared once so there is one place to
  // change rather than two to forget.
  const LAST_COMMAND_TYPE = CommandType.SetLightingBackend;

  it('keeps every payload within the 16-byte wire limit', () => {
    for (let t = 0; t <= LAST_COMMAND_TYPE; t++) {
      const size = PAYLOAD_SIZES[t as CommandType];
      expect(size, `command ${t}`).toBeLessThanOrEqual(16);
      expect(size, `command ${t}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('has a payload size declared for every discriminant up to the last one', () => {
    // A missing entry would make writeCommand emit a malformed message and
    // desynchronise the whole stream from that byte onwards.
    for (let t = 0; t <= LAST_COMMAND_TYPE; t++) {
      expect(PAYLOAD_SIZES[t as CommandType], `command ${t}`).toBeTypeOf('number');
    }
  });
});

// ── Phase 17: 2D lighting protocol ─────────────────────────────
describe('phase 17 lighting command types', () => {
  it('declares the four discriminants at 53-56', () => {
    expect(CommandType.SetLightFlags).toBe(53);
    expect(CommandType.SetLightingFlags).toBe(54);
    expect(CommandType.SetAmbientLight).toBe(55);
    expect(CommandType.SetLightingBackend).toBe(56);
  });

  it('declares payload sizes matching the Rust payload_size() arms', () => {
    expect(PAYLOAD_SIZES[CommandType.SetLightFlags]).toBe(4);
    expect(PAYLOAD_SIZES[CommandType.SetLightingFlags]).toBe(1);
    expect(PAYLOAD_SIZES[CommandType.SetAmbientLight]).toBe(16);
    expect(PAYLOAD_SIZES[CommandType.SetLightingBackend]).toBe(1);
  });
});
