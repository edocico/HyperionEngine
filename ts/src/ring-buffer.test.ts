import { describe, it, expect } from "vitest";
import { RingBufferProducer, CommandType } from "./ring-buffer";

const HEADER_SIZE = 16;
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
    const sab = new SharedArrayBuffer(16 + 128);
    const rb = new RingBufferProducer(sab);

    const packed = (2 << 16) | 10; // tier 2, layer 10
    const ok = rb.setTextureLayer(5, packed);
    expect(ok).toBe(true);

    // Message: 1 (cmd) + 4 (entity_id) + 4 (u32 payload) = 9 bytes
    const header = new Int32Array(sab, 0, 4);
    const writeHead = Atomics.load(header, 0);
    expect(writeHead).toBe(9);

    // Verify command type
    const data = new Uint8Array(sab, 16, 128);
    expect(data[0]).toBe(7); // CommandType.SetTextureLayer

    // Verify entity ID = 5
    const entityId = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
    expect(entityId).toBe(5);

    // Verify packed payload
    const payload = data[5] | (data[6] << 8) | (data[7] << 16) | (data[8] << 24);
    expect(payload).toBe(packed);
  });

  it('should write SetMeshHandle command', () => {
    const sab = new SharedArrayBuffer(1024);
    const rb = new RingBufferProducer(sab);
    const payload = new Float32Array(1);
    // Reinterpret u32 as f32 for the ring buffer encoding
    new Uint32Array(payload.buffer)[0] = 42;
    const ok = rb.writeCommand(CommandType.SetMeshHandle, 1, payload);
    expect(ok).toBe(true);
  });

  it('should write SetRenderPrimitive command', () => {
    const sab = new SharedArrayBuffer(1024);
    const rb = new RingBufferProducer(sab);
    const payload = new Float32Array(1);
    new Uint32Array(payload.buffer)[0] = 2; // SDFGlyph
    const ok = rb.writeCommand(CommandType.SetRenderPrimitive, 1, payload);
    expect(ok).toBe(true);
  });
});
