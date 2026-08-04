/**
 * Single source of truth for the render-target formats shared across passes.
 *
 * ## Why this file exists
 *
 * `scene-hdr` — the intermediate target that `ForwardPass` writes and that
 * `BloomPass`, `FXAATonemapPass`, `OutlineCompositePass` and `LineBatchPass`
 * read — used to be created with `navigator.gpu.getPreferredCanvasFormat()`.
 * That returns `bgra8unorm` or `rgba8unorm`: 8 bits per channel, clamped to
 * [0, 1]. Every value was therefore clamped *before* post-processing ran,
 * which made two already-shipped features inert:
 *
 * - `BloomPass` thresholds on values greater than 1.0 — which could not exist,
 *   so the threshold only ever selected on the [0,1] range it was given.
 * - `FXAATonemapPass` applies ACES / PBR-Neutral tonemapping, whose whole job
 *   is compressing high dynamic range into displayable range. With an input
 *   already in [0,1] there was nothing to compress.
 *
 * It is also the prerequisite for any additive light accumulation: summing
 * several overlapping lights into an 8-bit target saturates at 1.0 almost
 * immediately.
 *
 * ## Why `rgba16float`
 *
 * It is renderable, **blendable** and filterable in **core** WebGPU — no
 * optional feature required. That matters because Firefox exposes no optional
 * features at all, so anything gated behind `rg11b10ufloat-renderable` or
 * `float32-blendable` would not be portable. `rg11b10ufloat` would also not
 * save anything on the attachment budget: it costs 8 bytes per sample against
 * `maxColorAttachmentBytesPerSample` (32) despite being 4 bytes in memory.
 *
 * Cost: 8 bytes/pixel instead of 4 — about +8.3 MB at 1920x1080.
 *
 * ## What must NOT use this constant
 *
 * Anything whose target is the **swapchain** — the bloom composite sub-pass,
 * `FXAATonemapPass`, `OutlineCompositePass`, `LineBatchPass` and the particle
 * renderer — must keep using `navigator.gpu.getPreferredCanvasFormat()`. Only
 * `scene-hdr` and the bloom mip chain use `SCENE_HDR_FORMAT`.
 *
 * Both halves of each pair must move together: `BloomPass` builds its extract /
 * downsample / upsample pipelines against `SCENE_HDR_FORMAT` while the renderer
 * creates the mip textures those pipelines render into. If one side changes and
 * the other does not, the mismatch is a hard validation error at draw time —
 * and invisible to the test suite, because WebGPU cannot run headless.
 */
export const SCENE_HDR_FORMAT: GPUTextureFormat = 'rgba16float';

/**
 * Format of the selection-seed and jump-flood ping-pong textures.
 *
 * Deliberately a separate constant from {@link SCENE_HDR_FORMAT} even though
 * the two currently hold the same value: these textures carry encoded seed
 * *coordinates*, not radiance. Tying them to the scene's HDR format would make
 * a future change to one silently rewrite the other.
 *
 * Shared by `SelectionSeedPass` (pipeline + seed texture), `JFAPass` (pipeline)
 * and the renderer's `jfa-a` / `jfa-b` ping-pong pair. 16-bit float is chosen
 * for the precision the UV encoding needs, and is renderable and filterable in
 * core WebGPU.
 */
export const JFA_FORMAT: GPUTextureFormat = 'rgba16float';
