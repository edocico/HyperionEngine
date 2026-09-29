---
name: linux-webgpu-chrome-flags
description: "On the Fedora dev machine, Chrome needs three flags for hardware WebGPU; the NVIDIA adapter cannot present to a canvas (compositor on the AMD iGPU); use the low-power adapter for visual checks"
metadata:
  node_type: memory
  type: reference
  originSessionId: 3924f2a4-71f3-4c1e-a190-785b94e0f374
  modified: 2026-09-26T11:53:29.076Z
---

On the Fedora Linux machine (RTX 4060 + AMD Radeon RDNA 3 iGPU), Chrome 154 without flags returns `null` from `navigator.gpu.requestAdapter()`.

- `--enable-unsafe-webgpu` alone gives SwiftShader (CPU, `isFallbackAdapter=true`).
- `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan` gives `nvidia/lovelace` by default, with `subgroups`, `timestamp-query`, `indirect-first-instance` and `texture-compression-bc`. The `chrome-devtools-gpu` MCP server (local scope in ~/.claude.json) launches Chrome with exactly these flags.

**The NVIDIA adapter cannot present to a canvas. This is the cause of the "device lost / VK_ERROR_OUT_OF_DEVICE_MEMORY" seen on every harness load.** Root-caused on 2026-09-26:
- ANY canvas swapchain on the NVIDIA device dies at the first `getCurrentTexture()`/submit, with every format and alphaMode tried.
- Offscreen render targets and compute on the same adapter work.
- Chrome's GPU process runs its compositor on the AMD iGPU (`--render-node-override=/dev/dri/renderD128`), and cross-GPU swapchain memory does not allocate.
- A SECOND, separate effect is also real (seen again on 2026-09-26, with no canvas at all): the FIRST NVIDIA device created on a page can fail its first allocations (invalid buffers, OOM not reported to a validation scope). Later NVIDIA devices on the same page work. So for a compute probe on NVIDIA, first create a throwaway device that allocates a buffer, or push an `out-of-memory` error scope and retry.
- It is NOT an engine bug.

**Workaround for visual checks:** force the AMD adapter, which has the same four features and presents fine. Use `navigate_page` with `initScript`:
`GPU.prototype.requestAdapter = (orig => function (o) { return orig.call(this, { ...(o || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)`.
The initScript lasts ONE navigation (found 2026-09-27): a TS edit while the harness is open makes Vite full-reload the page WITHOUT it, the reload picks NVIDIA and dies with the same OOM, so every check reads "Device is lost". The tell is a second `[vite] connecting...` + an `nvidia / lovelace` adapter line. Re-navigate with the initScript after every TS edit (the 18 hot-reloadable WGSL files swap in place and keep the page).
Keep the NVIDIA adapter for compute-only measurements (benchmarks, probes via `evaluate_script`). Its timestamp-query returns real values at ~1.024 µs with no extra flag.

**Why:** the canvas has been black in every GPU session because of this. It masked the engine bugs fixed on 2026-09-26 as well.
**How to apply:** first check in every GPU session is the adapter line in the console (`[Hyperion] WebGPU adapter: ...`). For anything visual, use the low-power initScript. See [[project-moved-macos-to-linux]] and [[cull-fix-decision-pending]].
