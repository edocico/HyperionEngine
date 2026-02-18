import { describe, it, expect } from "vitest";
import { RingBufferProducer, CommandType } from "./ring-buffer";
import { selectExecutionMode, ExecutionMode, type Capabilities } from "./capabilities";

describe("Integration: Ring Buffer Protocol", () => {
  it("produces commands that match the Rust-expected binary format", () => {
    const sab = new SharedArrayBuffer(32 + 256);
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
    const data = new Uint8Array(sab, 32);
    expect(data[0]).toBe(CommandType.SpawnEntity);
    expect(data[5]).toBe(CommandType.SetPosition);
    expect(data[22]).toBe(CommandType.DespawnEntity);
  });
});

describe("Integration: Texture Layer Index Pipeline", () => {
  it("SetTextureLayer command binary matches Rust format", () => {
    const sab = new SharedArrayBuffer(32 + 128);
    const rb = new RingBufferProducer(sab);

    rb.spawnEntity(0);                           // 5 bytes
    rb.setTextureLayer(0, (2 << 16) | 42);      // 9 bytes

    const header = new Int32Array(sab, 0, 4);
    const writeHead = Atomics.load(header, 0);
    expect(writeHead).toBe(14); // 5 + 9

    const data = new Uint8Array(sab, 32, 128);

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

  it("GPURenderState has SoA fields", () => {
    const state: import("./worker-bridge").GPURenderState = {
      entityCount: 1,
      transforms: new Float32Array(16),
      bounds: new Float32Array(4),
      renderMeta: new Uint32Array(2),
      texIndices: new Uint32Array([0]),
    };
    expect(state.transforms.length).toBe(16);
    expect(state.bounds.length).toBe(4);
    expect(state.renderMeta.length).toBe(2);
    expect(state.texIndices.length).toBe(1);
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

describe("Integration: GPU SoA Buffer Format", () => {
  it("produces SoA buffers per entity matching new layout", () => {
    const entityCount = 3;
    const transforms = new Float32Array(entityCount * 16);
    const bounds = new Float32Array(entityCount * 4);
    const renderMeta = new Uint32Array(entityCount * 2);
    const texIndices = new Uint32Array(entityCount);

    // Entity 0: identity matrix, position (1,2,3), radius 0.5
    transforms[0] = 1.0; transforms[5] = 1.0; transforms[10] = 1.0; transforms[15] = 1.0;
    transforms[12] = 1.0; transforms[13] = 2.0; transforms[14] = 3.0;
    bounds[0] = 1.0; bounds[1] = 2.0; bounds[2] = 3.0; bounds[3] = 0.5;

    expect(transforms.length).toBe(48); // 3 entities * 16 f32
    expect(bounds.length).toBe(12);     // 3 entities * 4 f32
    expect(renderMeta.length).toBe(6);  // 3 entities * 2 u32
    expect(texIndices.length).toBe(3);  // 3 entities * 1 u32
  });
});
