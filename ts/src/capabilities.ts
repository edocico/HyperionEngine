export const enum ExecutionMode {
  /** Full isolation: 3 threads (Main + ECS Worker + Render Worker) */
  FullIsolation = "A",
  /** Partial isolation: 2 threads (Main+Render + ECS Worker) */
  PartialIsolation = "B",
  /** Single thread: everything on Main Thread */
  SingleThread = "C",
}

export interface Capabilities {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  offscreenCanvas: boolean;
  webgpu: boolean;
  webgpuInWorker: boolean;
}

export function detectCapabilities(): Capabilities {
  const crossOriginIsolated =
    typeof globalThis.crossOriginIsolated === "boolean"
      ? globalThis.crossOriginIsolated
      : false;

  const sharedArrayBuffer =
    crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";

  const offscreenCanvas = typeof OffscreenCanvas !== "undefined";

  const webgpu = "gpu" in navigator;

  // WebGPU in Workers: we can't definitively test this from Main Thread.
  // Use a known-good heuristic: Chrome/Edge support it, Firefox does not yet.
  const ua = navigator.userAgent;
  const isChromium = /Chrome\//.test(ua) && !/Edg\//.test(ua);
  const isEdge = /Edg\//.test(ua);
  const webgpuInWorker = webgpu && offscreenCanvas && (isChromium || isEdge);

  return {
    crossOriginIsolated,
    sharedArrayBuffer,
    offscreenCanvas,
    webgpu,
    webgpuInWorker,
  };
}

export function selectExecutionMode(caps: Capabilities): ExecutionMode {
  if (caps.sharedArrayBuffer && caps.webgpuInWorker && caps.offscreenCanvas) {
    return ExecutionMode.FullIsolation;
  }
  if (caps.sharedArrayBuffer && caps.webgpu) {
    return ExecutionMode.PartialIsolation;
  }
  return ExecutionMode.SingleThread;
}

export function logCapabilities(caps: Capabilities, mode: ExecutionMode): void {
  console.group("Hyperion Engine — Capabilities");
  console.log("Cross-Origin Isolated:", caps.crossOriginIsolated);
  console.log("SharedArrayBuffer:", caps.sharedArrayBuffer);
  console.log("OffscreenCanvas:", caps.offscreenCanvas);
  console.log("WebGPU:", caps.webgpu);
  console.log("WebGPU in Worker:", caps.webgpuInWorker);
  console.log("Execution Mode:", mode);

  if (!caps.crossOriginIsolated) {
    console.warn(
      "COOP/COEP headers not set. SharedArrayBuffer unavailable. " +
        "Running in single-thread mode. Set these headers for full performance:\n" +
        "  Cross-Origin-Opener-Policy: same-origin\n" +
        "  Cross-Origin-Embedder-Policy: require-corp"
    );
  }

  console.groupEnd();
}

/**
 * Detect the best GPU-compressed texture format from adapter features.
 * Priority: BC7 (desktop) > ASTC 4x4 (mobile) > null (no compression).
 */
export function detectCompressedFormat(
  adapterFeatures: ReadonlySet<string>,
): GPUTextureFormat | null {
  if (adapterFeatures.has('texture-compression-bc')) return 'bc7-rgba-unorm';
  if (adapterFeatures.has('texture-compression-astc')) return 'astc-4x4-unorm';
  return null;
}

/**
 * Result of subgroup feature detection.
 */
export interface SubgroupSupport {
  supported: boolean;
  /** Chrome 144+: @builtin(subgroup_id) and @builtin(num_subgroups) available */
  hasSubgroupId: boolean;
}

/**
 * Detect whether the GPU adapter supports subgroup operations.
 *
 * - `supported`: adapter has 'subgroups' feature (subgroupExclusiveAdd, etc.)
 * - `hasSubgroupId`: WGSL has 'subgroup_id' language feature (Chrome 144+)
 *
 * At `requestDevice()` time, add `'subgroups'` to `requiredFeatures` if supported.
 */
export function detectSubgroupSupport(
  adapterFeatures: ReadonlySet<string>,
): SubgroupSupport {
  const supported = adapterFeatures.has('subgroups');
  const hasSubgroupId = supported &&
    !!(navigator as any).gpu?.wgslLanguageFeatures?.has('subgroup_id');
  return { supported, hasSubgroupId };
}

/**
 * Result of sized binding array feature detection.
 */
export interface SizedBindingArraySupport {
  supported: boolean;
  /** Maximum binding array size (0 if unsupported). Discovery is empirical. */
  maxSize: number;
}

/**
 * Detect WebGPU sized binding arrays support.
 * Uses try/catch on createBindGroupLayout with bindingArraySize.
 * W3C proposal hasn't finalized the limit name, so maxSize is probed empirically.
 */
export function detectSizedBindingArrays(device: GPUDevice): SizedBindingArraySupport {
  // Use numeric constant 0x2 for GPUShaderStage.FRAGMENT to avoid
  // ReferenceError in environments without WebGPU globals (e.g., tests).
  const FRAGMENT = 0x2;
  try {
    device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: FRAGMENT,
        texture: { bindingArraySize: 256 } as any,
      }],
    });
    // Probe max size: try 256, 512, 1024
    let maxSize = 256;
    for (const size of [512, 1024]) {
      try {
        device.createBindGroupLayout({
          entries: [{
            binding: 0,
            visibility: FRAGMENT,
            texture: { bindingArraySize: size } as any,
          }],
        });
        maxSize = size;
      } catch {
        break;
      }
    }
    return { supported: true, maxSize };
  } catch {
    return { supported: false, maxSize: 0 };
  }
}

/**
 * One log line about the WebGPU adapter, and whether it is a software
 * fallback (SwiftShader). A fallback renders, so nothing else notices it —
 * but its GPU timings and feature set are not the hardware's, which silently
 * invalidates any measurement or feature probe taken on it.
 */
export function describeAdapter(info: GPUAdapterInfo | undefined): { message: string; fallback: boolean } {
  if (!info) {
    return { message: '[Hyperion] WebGPU adapter: unknown (adapter.info not exposed)', fallback: false };
  }
  const name = [info.vendor, info.architecture, info.device].filter(Boolean).join(' / ') || 'unnamed';
  const subgroups = info.subgroupMinSize !== undefined
    ? `, subgroups ${info.subgroupMinSize}-${info.subgroupMaxSize ?? '?'}`
    : '';
  if (info.isFallbackAdapter) {
    // Linux is fixed by adding flags, macOS by dropping them. Measured on Chrome 154 /
    // Apple M2 Pro (2026-09-30), default adapter: no flags gives Metal;
    // `--use-webgpu-adapter=swiftshader` alone, `--disable-gpu` and `--use-gl=disabled`
    // give NO adapter (createRenderer then throws, never reaching this line); SwiftShader
    // is offered only under `--enable-unsafe-webgpu`, and is the default adapter only with
    // `--use-webgpu-adapter=swiftshader` too.
    return {
      message: `[Hyperion] WebGPU adapter: ${name}${subgroups} — SOFTWARE FALLBACK: GPU timings and features `
        + 'are not the hardware\'s. On Linux Chrome needs --enable-unsafe-webgpu --enable-features=Vulkan '
        + '--use-angle=vulkan for the real GPU. On macOS Chrome needs no flag: it offers a software adapter '
        + 'only under --enable-unsafe-webgpu, and makes it the default with --use-webgpu-adapter=swiftshader, '
        + 'so drop that flag.',
      fallback: true,
    };
  }
  return { message: `[Hyperion] WebGPU adapter: ${name}${subgroups}`, fallback: false };
}

/**
 * The features `createRenderer` asks `requestDevice` for, given what the
 * adapter offers. Only features the adapter advertises are included: asking for
 * one it lacks makes `requestDevice` reject.
 *
 * `'indirect-first-instance'` is a correctness requirement, not an
 * optimisation. `CullPass` encodes each bucket's visible-indices region as a
 * non-zero `firstInstance`, and without the feature the spec turns every such
 * indirect draw into a silent no-op.
 */
export function selectDeviceFeatures(
  adapterFeatures: ReadonlySet<string>,
  compressedFormat: GPUTextureFormat | null,
  subgroupsSupported: boolean,
): GPUFeatureName[] {
  const features: GPUFeatureName[] = [];
  if (compressedFormat === 'bc7-rgba-unorm') features.push('texture-compression-bc');
  else if (compressedFormat === 'astc-4x4-unorm') features.push('texture-compression-astc');
  if (subgroupsSupported) features.push('subgroups' as GPUFeatureName);
  // GPU timing. Optional everywhere: absent on some mobile drivers, and the
  // device request must still succeed without it. See render/gpu-profiler.ts.
  if (adapterFeatures.has('timestamp-query')) features.push('timestamp-query');
  if (adapterFeatures.has('indirect-first-instance')) features.push('indirect-first-instance');
  return features;
}

/**
 * The features to retry with when `requestDevice` rejects the full set. Drops
 * the ones the engine runs correctly without (subgroups, GPU timing). Keeps
 * texture compression, which the asset pipeline depends on, and
 * `'indirect-first-instance'`, without which most draws vanish.
 */
export function retryDeviceFeatures(requested: readonly GPUFeatureName[]): GPUFeatureName[] {
  return requested.filter(f => f !== ('subgroups' as GPUFeatureName) && f !== 'timestamp-query');
}

/**
 * A console warning for a device without `'indirect-first-instance'`, or
 * `null` when it has it. Must be read from `device.features`, never from the
 * adapter's: that is the set the draws actually run under.
 */
export function indirectFirstInstanceWarning(deviceFeatures: ReadonlySet<string>): string | null {
  if (deviceFeatures.has('indirect-first-instance')) return null;
  return "[Hyperion] The GPU device lacks 'indirect-first-instance': indirect draws with a non-zero "
    + 'firstInstance are no-ops, so only opaque tier-0 quads will render. Every other primitive type '
    + 'and every transparent entity is missing.';
}

/**
 * Whether `cull.wgsl`'s subgroup path is correct on this adapter: only when
 * every subgroup is exactly 32 lanes.
 *
 * The shader derives the subgroup index as `lid / SUBGROUP_SIZE` with a fixed
 * SUBGROUP_SIZE of 32. With any other width, the per-bucket counts stay right
 * but the visible indices are scattered to the wrong slots: some entities are
 * drawn twice, others go missing, and nothing reports an error. An adapter
 * that does not state its range is refused. The atomic path is correct
 * everywhere, and at 50% visibility it was measured faster anyway.
 */
export function subgroupCullSupported(info: GPUAdapterInfo | undefined): boolean {
  return info?.subgroupMinSize === 32 && info?.subgroupMaxSize === 32;
}
