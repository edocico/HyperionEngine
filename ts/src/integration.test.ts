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
