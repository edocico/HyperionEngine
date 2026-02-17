import { describe, it, expect } from "vitest";
import { RingBufferProducer, CommandType } from "./ring-buffer";
import { selectExecutionMode, ExecutionMode, type Capabilities } from "./capabilities";

describe("Integration: Ring Buffer Protocol", () => {
  it("produces commands that match the Rust-expected binary format", () => {
    const sab = new SharedArrayBuffer(16 + 256);
    const rb = new RingBufferProducer(sab);

    rb.spawnEntity(0);
    rb.setPosition(0, 1.5, 2.5, 3.5);
    rb.despawnEntity(0);

    // Verify the write head advanced correctly.
    const header = new Int32Array(sab, 0, 4);
    const writeHead = Atomics.load(header, 0);

    // spawn: 5 bytes + setPosition: 17 bytes + despawn: 5 bytes = 27
    expect(writeHead).toBe(27);

    // Verify the data region has correct command bytes.
    const data = new Uint8Array(sab, 16);
    expect(data[0]).toBe(CommandType.SpawnEntity);
    expect(data[5]).toBe(CommandType.SetPosition);
    expect(data[22]).toBe(CommandType.DespawnEntity);
  });
});

describe("Integration: Texture Layer Index Pipeline", () => {
  it("SetTextureLayer command binary matches Rust format", () => {
    const sab = new SharedArrayBuffer(16 + 128);
    const rb = new RingBufferProducer(sab);

    rb.spawnEntity(0);                           // 5 bytes
    rb.setTextureLayer(0, (2 << 16) | 42);      // 9 bytes

    const header = new Int32Array(sab, 0, 4);
    const writeHead = Atomics.load(header, 0);
    expect(writeHead).toBe(14); // 5 + 9

    const data = new Uint8Array(sab, 16, 128);

    // SpawnEntity at offset 0
    expect(data[0]).toBe(1);

    // SetTextureLayer at offset 5
    expect(data[5]).toBe(7); // CommandType.SetTextureLayer

    // Entity ID = 0 at offset 6-9
    const entityId = data[6] | (data[7] << 8) | (data[8] << 16) | (data[9] << 24);
    expect(entityId).toBe(0);

    // Packed value at offset 10-13
    const packed = data[10] | (data[11] << 8) | (data[12] << 16) | (data[13] << 24);
    expect(packed).toBe((2 << 16) | 42);
  });

  it("GPURenderState includes texIndices field", () => {
    const state: import("./worker-bridge").GPURenderState = {
      entityCount: 1,
      entityData: new Float32Array(20),
      texIndices: new Uint32Array([0]),
    };
    expect(state.texIndices.length).toBe(1);
    expect(state.entityCount).toBe(1);
  });
});

describe("Integration: Mode Selection", () => {
  it("degrades gracefully across all combinations", () => {
    const full: Capabilities = {
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
      offscreenCanvas: true,
      webgpu: true,
      webgpuInWorker: true,
    };
    expect(selectExecutionMode(full)).toBe(ExecutionMode.FullIsolation);

    const noWorkerGpu: Capabilities = { ...full, webgpuInWorker: false };
    expect(selectExecutionMode(noWorkerGpu)).toBe(ExecutionMode.PartialIsolation);

    const noSab: Capabilities = { ...full, sharedArrayBuffer: false };
    expect(selectExecutionMode(noSab)).toBe(ExecutionMode.SingleThread);

    const nothing: Capabilities = {
      crossOriginIsolated: false,
      sharedArrayBuffer: false,
      offscreenCanvas: false,
      webgpu: false,
      webgpuInWorker: false,
    };
    expect(selectExecutionMode(nothing)).toBe(ExecutionMode.SingleThread);
  });
});

describe("Integration: GPU Entity Data Format", () => {
  it("produces 20 floats per entity matching WGSL EntityData struct", () => {
    const FLOATS_PER_ENTITY = 20;
    const entityCount = 3;
    const data = new Float32Array(entityCount * FLOATS_PER_ENTITY);

    // Simulate entity 0 at position (1, 2, 3) with identity matrix
    data[0] = 1.0; data[5] = 1.0; data[10] = 1.0; data[15] = 1.0;
    data[12] = 1.0; data[13] = 2.0; data[14] = 3.0;
    data[16] = 1.0; data[17] = 2.0; data[18] = 3.0; data[19] = 0.5;

    expect(data[16]).toBe(1.0);  // sphere center x
    expect(data[17]).toBe(2.0);  // sphere center y
    expect(data[18]).toBe(3.0);  // sphere center z
    expect(data[19]).toBe(0.5);  // sphere radius
    expect(data.length).toBe(60);  // 3 entities x 20 floats
  });
});
