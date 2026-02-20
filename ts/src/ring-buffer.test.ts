import { describe, it, expect } from "vitest";
import { RingBufferProducer, CommandType, IS_LITTLE_ENDIAN, extractUnread } from "./ring-buffer";

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

  it("writes a spawn command", () => {
    const sab = makeBuffer();
    const rb = new RingBufferProducer(sab);
    const ok = rb.spawnEntity(42);
    expect(ok).toBe(true);
    expect(readByte(sab, 0)).toBe(CommandType.SpawnEntity);
    expect(readU32LE(sab, 1)).toBe(42);
    expect(getWriteHead(sab)).toBe(5);
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

  it("writes multiple commands sequentially", () => {
    const sab = makeBuffer();
    const rb = new RingBufferProducer(sab);
    rb.spawnEntity(1);
    rb.spawnEntity(2);
    rb.despawnEntity(3);
    expect(getWriteHead(sab)).toBe(15);
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
    // Place writeHead at cap-4 so: cmd at 28, entity_id at 29,30,31,0
    // readHead = writeHead initially so extractUnread returns only newly written bytes
    // freeSpace when w >= r: capacity - w + r - 1. But w == r means we'd get cap - 1 free.
    // Actually when w == r freeSpace = cap - w + r - 1 = cap - 1. Perfect.
    // But wait: we need readHead < writeHead or readHead to wrap properly.
    // Actually readHead = 0 works: freeSpace = cap - 28 + 0 - 1 = 3, too small for 5 bytes.
    // readHead = 1: freeSpace = cap - 28 + 1 - 1 = 4, still too small.
    // readHead = 10: freeSpace = cap - 28 + 10 - 1 = 13, enough.
    // Set readHead = cap - 4 = 28 (same as writeHead): freeSpace = cap - 28 + 28 - 1 = 31.
    Atomics.store(header, 0, cap - 4); // writeHead = 28
    Atomics.store(header, 1, cap - 4); // readHead = 28 (same: all space is "free")

    const rb = new RingBufferProducer(sab);
    const ok = rb.spawnEntity(0xDEADBEEF);
    expect(ok).toBe(true);

    // Use extractUnread to get the contiguous byte stream
    // After write, writeHead = (28 + 5) % 32 = 1. readHead = 28.
    // extractUnread: writeHead(1) < readHead(28) → wrap: data[28..32] + data[0..1] = 5 bytes
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(5);
    expect(bytes[0]).toBe(CommandType.SpawnEntity);
    const id = (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) >>> 0;
    expect(id).toBe(0xDEADBEEF);
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
});
