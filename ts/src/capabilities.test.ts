import { describe, it, expect } from "vitest";
import {
  selectExecutionMode,
  ExecutionMode,
  detectCompressedFormat,
  detectSubgroupSupport,
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

describe("detectCompressedFormat", () => {
  it("returns bc7-rgba-unorm when texture-compression-bc is available", () => {
    const features = new Set(['texture-compression-bc']);
    expect(detectCompressedFormat(features)).toBe('bc7-rgba-unorm');
  });

  it("returns astc-4x4-unorm when only texture-compression-astc is available", () => {
    const features = new Set(['texture-compression-astc']);
    expect(detectCompressedFormat(features)).toBe('astc-4x4-unorm');
  });

  it("prefers BC7 over ASTC when both are available", () => {
    const features = new Set(['texture-compression-bc', 'texture-compression-astc']);
    expect(detectCompressedFormat(features)).toBe('bc7-rgba-unorm');
  });

  it("returns null when neither is available", () => {
    const features = new Set<string>();
    expect(detectCompressedFormat(features)).toBeNull();
  });
});

describe("detectSubgroupSupport", () => {
  it("returns supported=false when feature not present", () => {
    const features = new Set<string>();
    expect(detectSubgroupSupport(features)).toEqual({ supported: false });
  });

  it("returns supported=true when subgroups feature present", () => {
    const features = new Set<string>(["subgroups"]);
    expect(detectSubgroupSupport(features)).toEqual({ supported: true });
  });

  it("returns supported=false for subgroups-f16-only (not what we need)", () => {
    const features = new Set<string>(["subgroups-f16"]);
    expect(detectSubgroupSupport(features)).toEqual({ supported: false });
  });
});
