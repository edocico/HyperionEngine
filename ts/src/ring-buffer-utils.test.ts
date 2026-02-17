import { describe, it, expect } from "vitest";
import { extractUnread } from "./ring-buffer";

const HEADER_SIZE = 16;

function makeSab(capacity: number): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_SIZE + capacity);
}

function writeBytes(
  sab: SharedArrayBuffer,
  dataOffset: number,
  bytes: number[]
): void {
  const data = new Uint8Array(sab, HEADER_SIZE);
  for (let i = 0; i < bytes.length; i++) {
    data[(dataOffset + i) % data.length] = bytes[i];
  }
}

function setWriteHead(sab: SharedArrayBuffer, val: number): void {
  Atomics.store(new Int32Array(sab, 0, 1), 0, val);
}

function setReadHead(sab: SharedArrayBuffer, val: number): void {
  Atomics.store(new Int32Array(sab, 0, 4), 1, val);
}

function getReadHead(sab: SharedArrayBuffer): number {
  return Atomics.load(new Int32Array(sab, 0, 4), 1);
}

describe("extractUnread", () => {
  it("returns empty when heads are equal", () => {
    const sab = makeSab(64);
    const { bytes, capacity } = extractUnread(sab);
    expect(bytes.length).toBe(0);
    expect(capacity).toBe(64);
  });

  it("extracts bytes between read and write head", () => {
    const sab = makeSab(64);
    writeBytes(sab, 0, [1, 2, 3, 4, 5]);
    setWriteHead(sab, 5);

    const { bytes } = extractUnread(sab);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(getReadHead(sab)).toBe(5);
  });

  it("handles wrap-around", () => {
    const sab = makeSab(8);
    // Simulate: readHead=6, writeHead=3, data wraps around
    setReadHead(sab, 6);
    setWriteHead(sab, 3);
    writeBytes(sab, 6, [10, 11]); // bytes 6,7
    writeBytes(sab, 0, [12, 13, 14]); // bytes 0,1,2

    const { bytes } = extractUnread(sab);
    expect(bytes).toEqual(new Uint8Array([10, 11, 12, 13, 14]));
    expect(getReadHead(sab)).toBe(3);
  });

  it("advances read head to write head", () => {
    const sab = makeSab(64);
    writeBytes(sab, 0, [1, 2, 3]);
    setWriteHead(sab, 3);

    extractUnread(sab);
    expect(getReadHead(sab)).toBe(3);

    // Second call returns empty
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(0);
  });
});
