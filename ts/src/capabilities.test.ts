import { describe, it, expect } from "vitest";
import {
  selectExecutionMode,
  ExecutionMode,
  type Capabilities,
} from "./capabilities";

function makeCaps(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
    offscreenCanvas: true,
    webgpu: true,
    webgpuInWorker: true,
    ...overrides,
  };
}

describe("selectExecutionMode", () => {
  it("selects Mode A when all capabilities present", () => {
    expect(selectExecutionMode(makeCaps())).toBe(ExecutionMode.FullIsolation);
  });

  it("selects Mode B when WebGPU in Worker is unavailable", () => {
    expect(
      selectExecutionMode(makeCaps({ webgpuInWorker: false }))
    ).toBe(ExecutionMode.PartialIsolation);
  });

  it("selects Mode C when SharedArrayBuffer is unavailable", () => {
    expect(
      selectExecutionMode(makeCaps({ sharedArrayBuffer: false }))
    ).toBe(ExecutionMode.SingleThread);
  });

  it("selects Mode C when no WebGPU", () => {
    expect(
      selectExecutionMode(makeCaps({ webgpu: false, sharedArrayBuffer: false }))
    ).toBe(ExecutionMode.SingleThread);
  });
});
