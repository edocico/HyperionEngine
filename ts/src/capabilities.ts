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
}

/**
 * Detect whether the GPU adapter supports the `subgroups` WebGPU feature.
 * This enables `subgroupExclusiveAdd()`, `subgroupAdd()`, etc. in compute shaders.
 *
 * Note: At `requestDevice()` time, the caller must add `'subgroups'` to
 * `requiredFeatures` if detection returns `supported: true`.
 */
export function detectSubgroupSupport(
  adapterFeatures: ReadonlySet<string>,
): SubgroupSupport {
  return { supported: adapterFeatures.has('subgroups') };
}
