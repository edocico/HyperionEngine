import { describe, it, expect } from "vitest";
import {
  selectExecutionMode,
  ExecutionMode,
  detectCompressedFormat,
  detectSubgroupSupport,
  detectSizedBindingArrays,
  describeAdapter,
  selectDeviceFeatures,
  retryDeviceFeatures,
  indirectFirstInstanceWarning,
  subgroupCullSupported,
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
    const result = detectSubgroupSupport(features);
    expect(result.supported).toBe(false);
    expect(result.hasSubgroupId).toBe(false);
  });

  it("returns supported=true when subgroups feature present", () => {
    const features = new Set<string>(["subgroups"]);
    const result = detectSubgroupSupport(features);
    expect(result.supported).toBe(true);
    expect(result.hasSubgroupId).toBe(false);
  });

  it("returns supported=false for subgroups-f16-only (not what we need)", () => {
    const features = new Set<string>(["subgroups-f16"]);
    const result = detectSubgroupSupport(features);
    expect(result.supported).toBe(false);
    expect(result.hasSubgroupId).toBe(false);
  });
});

describe("detectSubgroupSupport v2 (subgroup_id builtins)", () => {
  it("returns hasSubgroupId=false when wgslLanguageFeatures not available", () => {
    const features = new Set<string>(["subgroups"]);
    const result = detectSubgroupSupport(features);
    expect(result.supported).toBe(true);
    expect(result.hasSubgroupId).toBe(false);
  });

  it("returns hasSubgroupId=true when subgroup_id in wgslLanguageFeatures", () => {
    const origGpu = (navigator as any).gpu;
    const hadGpu = 'gpu' in navigator;
    Object.defineProperty(navigator, 'gpu', {
      value: { wgslLanguageFeatures: new Set(["subgroup_id"]) },
      writable: true,
      configurable: true,
    });
    try {
      const features = new Set<string>(["subgroups"]);
      const result = detectSubgroupSupport(features);
      expect(result.supported).toBe(true);
      expect(result.hasSubgroupId).toBe(true);
    } finally {
      if (hadGpu) {
        Object.defineProperty(navigator, 'gpu', {
          value: origGpu,
          writable: true,
          configurable: true,
        });
      } else {
        delete (navigator as any).gpu;
      }
    }
  });

  it("returns hasSubgroupId=false when subgroups not supported", () => {
    const features = new Set<string>();
    const result = detectSubgroupSupport(features);
    expect(result.supported).toBe(false);
    expect(result.hasSubgroupId).toBe(false);
  });
});

describe("detectSizedBindingArrays", () => {
  it("returns supported=false and maxSize=0 when feature not available", () => {
    const mockDevice = {
      features: new Set(),
      createBindGroupLayout: () => { throw new Error("not supported"); },
    } as unknown as GPUDevice;
    const result = detectSizedBindingArrays(mockDevice);
    expect(result.supported).toBe(false);
    expect(result.maxSize).toBe(0);
  });

  it("returns supported=true when createBindGroupLayout accepts bindingArraySize", () => {
    const mockLayout = {};
    const mockDevice = {
      features: new Set(),
      createBindGroupLayout: () => mockLayout,
    } as unknown as GPUDevice;
    const result = detectSizedBindingArrays(mockDevice);
    expect(result.supported).toBe(true);
    expect(result.maxSize).toBeGreaterThanOrEqual(256);
  });

  it("probes maxSize up to 1024", () => {
    let callCount = 0;
    const mockDevice = {
      features: new Set(),
      createBindGroupLayout: () => {
        callCount++;
        return {};
      },
    } as unknown as GPUDevice;
    const result = detectSizedBindingArrays(mockDevice);
    expect(result.supported).toBe(true);
    expect(result.maxSize).toBe(1024);
    // Initial probe (256) + 2 size probes (512, 1024) = 3 calls
    expect(callCount).toBe(3);
  });

  it("stops probing at first failure", () => {
    let callCount = 0;
    const mockDevice = {
      features: new Set(),
      createBindGroupLayout: () => {
        callCount++;
        if (callCount > 1) throw new Error("too large");
        return {};
      },
    } as unknown as GPUDevice;
    const result = detectSizedBindingArrays(mockDevice);
    expect(result.supported).toBe(true);
    expect(result.maxSize).toBe(256);
  });
});

describe("describeAdapter", () => {
  function info(overrides: Partial<GPUAdapterInfo>): GPUAdapterInfo {
    return {
      vendor: "", architecture: "", device: "", description: "",
      isFallbackAdapter: false, ...overrides,
    } as GPUAdapterInfo;
  }

  it("names the adapter and its subgroup sizes", () => {
    const d = describeAdapter(info({
      vendor: "nvidia", architecture: "lovelace", subgroupMinSize: 32, subgroupMaxSize: 32,
    }));
    expect(d.fallback).toBe(false);
    expect(d.message).toMatch(/nvidia \/ lovelace.*subgroups 32-32/);
  });

  it("flags a software fallback adapter: its timings and features are not the hardware's", () => {
    // Chrome on Linux with only --enable-unsafe-webgpu hands out SwiftShader,
    // and the engine used to accept it without a word.
    const d = describeAdapter(info({ vendor: "google", architecture: "swiftshader", isFallbackAdapter: true }));
    expect(d.fallback).toBe(true);
    expect(d.message).toMatch(/software fallback/i);
  });

  it("says what a fallback means on each platform: Linux needs flags, macOS needs none", () => {
    // Measured on Chrome 154 / Apple M2 Pro (2026-09-30), one separate headless
    // instance per row, asking for the default adapter:
    //   no flags                                          -> Metal, not a fallback
    //   --use-webgpu-adapter=swiftshader                  -> NO adapter at all
    //   --use-webgpu-adapter=swiftshader
    //     --enable-unsafe-webgpu                          -> SwiftShader, a fallback
    //   --disable-gpu, --use-gl=disabled, ...             -> NO adapter at all
    // So on the Mac a fallback is SwiftShader chosen by flags, and the cure there
    // is to DROP flags, the opposite of Linux.
    const d = describeAdapter(info({ vendor: "google", architecture: "swiftshader", isFallbackAdapter: true }));
    expect(d.fallback).toBe(true);
    // Linux: the flags that hand Chrome the real GPU (all the message named before).
    for (const flag of ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan"]) {
      expect(d.message).toContain(flag);
    }
    // macOS: no flag needed, and the two flags that select SwiftShader together.
    expect(d.message).toMatch(/macOS[^.]*no flag/i);
    const mac = d.message.slice(d.message.indexOf("macOS"));
    expect(mac).toContain("--use-webgpu-adapter=swiftshader");
    expect(mac).toContain("--enable-unsafe-webgpu");
  });

  it("keeps the platform hints off a hardware adapter's line", () => {
    // The line every Mac session starts with (M0, stock Chrome: no device id).
    const d = describeAdapter(info({
      vendor: "apple", architecture: "metal-3", subgroupMinSize: 32, subgroupMaxSize: 32,
    }));
    expect(d.fallback).toBe(false);
    expect(d.message).toBe("[Hyperion] WebGPU adapter: apple / metal-3, subgroups 32-32");
  });

  it("an adapter without info is unknown, not assumed to be hardware or fallback", () => {
    const d = describeAdapter(undefined);
    expect(d.fallback).toBe(false);
    expect(d.message).toMatch(/unknown/);
  });
});

// cull-pass.ts gives every bucket but 0 a non-zero firstInstance (the offset of
// its region in visible-indices). That is 23 of ForwardPass's 24 indirect
// draws, plus 1 of SelectionSeedPass's 2 when outlines are on. Without the
// 'indirect-first-instance' feature the spec turns each of those draws into a
// no-op, with no validation error. Measured on an RTX 4060: 0 pixels without
// the feature, drawn with it. Only bucket 0 (opaque tier-0 quads) survives,
// so every other primitive type and every transparent entity vanishes silently.
describe("selectDeviceFeatures", () => {
  it("requests indirect-first-instance whenever the adapter offers it", () => {
    const features = selectDeviceFeatures(new Set(["indirect-first-instance"]), null, false);
    expect(features).toContain("indirect-first-instance");
  });

  it("does not request indirect-first-instance from an adapter without it", () => {
    expect(selectDeviceFeatures(new Set(), null, false)).not.toContain("indirect-first-instance");
  });

  it("keeps requesting what it already did: compression, subgroups, timestamps", () => {
    const adapter = new Set(["texture-compression-bc", "subgroups", "timestamp-query"]);
    expect(selectDeviceFeatures(adapter, "bc7-rgba-unorm", true)).toEqual(
      expect.arrayContaining(["texture-compression-bc", "subgroups", "timestamp-query"]),
    );
    expect(selectDeviceFeatures(new Set(["texture-compression-astc"]), "astc-4x4-unorm", false))
      .toEqual(["texture-compression-astc"]);
  });
});

describe("retryDeviceFeatures", () => {
  it("drops only the features the engine runs without, and keeps indirect-first-instance", () => {
    // Dropping it on the retry would turn a rejected feature request into a
    // canvas that draws only quads, with nothing in the console to say why.
    const retry = retryDeviceFeatures(
      ["texture-compression-bc", "subgroups", "timestamp-query", "indirect-first-instance"] as GPUFeatureName[],
    );
    expect(retry).toEqual(["texture-compression-bc", "indirect-first-instance"]);
  });
});

describe("indirectFirstInstanceWarning", () => {
  it("is silent on a device that has the feature", () => {
    expect(indirectFirstInstanceWarning(new Set(["indirect-first-instance"]))).toBeNull();
  });

  it("warns on a device without it, naming the feature and what goes missing", () => {
    const warning = indirectFirstInstanceWarning(new Set());
    expect(warning).toContain("indirect-first-instance");
    expect(warning).toMatch(/only opaque/i);
  });
});

// cull.wgsl's subgroup path derives the subgroup index as `lid / SUBGROUP_SIZE`
// with SUBGROUP_SIZE = 32. On hardware whose subgroups are not exactly 32
// lanes the per-bucket COUNTS stay right while the visible-indices get
// corrupted: some entities drawn twice, others missing, no error anywhere.
// Examples are AMD wave64 (RDNA reports 32-64), Intel (8-32), Qualcomm and
// Mali. The path first ran after 6331b5c made the cull pipeline valid.
describe("subgroupCullSupported", () => {
  const info = (min?: number, max?: number) => ({ subgroupMinSize: min, subgroupMaxSize: max }) as unknown as GPUAdapterInfo;

  it("allows the subgroup cull path when subgroups are exactly 32 lanes (NVIDIA, Apple)", () => {
    expect(subgroupCullSupported(info(32, 32))).toBe(true);
  });

  it("refuses it when the size can vary or differs from 32", () => {
    expect(subgroupCullSupported(info(32, 64))).toBe(false);   // AMD RDNA
    expect(subgroupCullSupported(info(64, 64))).toBe(false);   // AMD GCN
    expect(subgroupCullSupported(info(8, 32))).toBe(false);    // Intel
    expect(subgroupCullSupported(info(16, 16))).toBe(false);   // Mali
  });

  it("refuses it when the adapter does not say", () => {
    expect(subgroupCullSupported(undefined)).toBe(false);
    expect(subgroupCullSupported(info())).toBe(false);
  });
});
