# Light Layer Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `lightLayers()` work. Every group of layers that shares the same lights and the same casters gets its own light buffer: a layer of one 2d-array. The groups are derived automatically each frame, as Unity's layer batches are.

**Architecture:** A pure function `deriveLightGroups` turns `renderMeta`/`primParams`/`bounds` and the camera into groups and SDF sets. One graph node, `LightGroupsPass`, replaces `occluder-seed`/`sdf-N`/`light-accum`. It runs set-major and reuses one seed and one ping-pong pair:
1. for each SDF set, seed and flood it;
2. accumulate each group that uses the set into its own layer of `light-buffer`.

ForwardPass samples that layer through a 16-entry layer→group table.

**Tech Stack:** TypeScript, WebGPU/WGSL, vitest. No Rust change.

**Spec:** `docs/plans/2026-09-26-phase17-light-layer-groups-design.md`

## Global Constraints

- **No change to the ring-buffer protocol, WASM exports, HSNP snapshot or `state_hash`.**
- **Default scene (lights 0xFFFF, drawables/occluders mask 0) = exactly today's GPU work:** 1 group, 1 SDF set.
- **Mask semantics:**
  - Light: `(mask & group.layers) != 0`. Mask 0 lights nothing.
  - Receiver: lowest set bit, 0 → layer 0.
  - Occluder: mask 0 → 0xFFFF; it is in set s iff `(mask & s.occluderLayers) != 0`.
- **No cap on SDF sets.** Groups ≤ 16 and sets ≤ 16 by construction.
- **Shadowed light (CPU = GPU):** lightType ∈ {Point 0, Spot 1} and `clamp(primParams[7], 0, 1) > 0`.
- **Frustum filter** for lights and occluders: `isSphereInFrustum(planes, x, y, z, r * 1.01 + 1e-3)`. No filter for receivers.
- **Uniform slices:** 256-byte aligned, written once per frame in `prepare()`.
- **`CameraUniform` in the six primitive shaders:** 80 B `{viewProjection, occluderLayers, _pad0, _pad1, _pad2}`. Group-0 binding 0 has `minBindingSize: 80`.
- **`LightingUniform` (basic/gradient):** 16 B `{enabled, groupTableLo, groupTableHi, _pad0}`. 4 bits per layer; layers 0-7 in Lo, 8-15 in Hi.
- **Commits:** Italian messages, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **npm commands:** use the cwd-independent form: `npx --prefix ts vitest run --root ts <file>`.

## Review Focus

1. **A light whose mask reaches no occupied layer** (e.g. `lightLayers(0b1000)` with no receiver on layer 3): it must draw nowhere and change no group. Covered in Task 1 by the test "a light on an unoccupied layer changes nothing".
2. **Lit graph with zero receivers, or zero lights:** exactly one fictitious group, one array layer cleared to ambient, and the ForwardPass binding stays valid. Covered in Task 1 ("zero receivers") and Task 6 ("zero groups still clears one layer").
3. **Masks changing every frame (G: 1 → 3 → 1):** grow-only array, no per-frame reallocation on shrink, bind groups rebuilt only when a view changes. Covered in Task 6 ("group count oscillates without reallocation").
4. **Canvas resize with G > 1:** every layer view and the SDF textures are recreated, and the bind groups follow. Covered in Task 6 ("resize recreates every layer view").
5. **16 distinct receiver layers, each with its own light and caster mask:** nibble 15, 16 sets, no overflow. Covered in Task 1 ("16 layers, 16 groups, 16 sets").

---

### Task 1: `deriveLightGroups` — the pure grouping function

**Files:**
- Create: `ts/src/render/light-groups.ts`
- Test: `ts/src/render/light-groups.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LightGroup { layers: number; sdfSet: number }        // sdfSet -1 = no SDF
  export interface LightGroups {
    groups: LightGroup[];                       // ≥ 1 (a fictitious {layers: 1, sdfSet: -1} when no receiver)
    sdfSets: Array<{ occluderLayers: number }>;
    layerToGroup: [number, number];             // lo = layers 0-7, hi = 8-15, 4 bits each
    multiBitReceiver: boolean;
    lightMasks: number[]; occluderMasks: number[];
  }
  export interface LightGroupsInput {
    entityCount: number; renderMeta: Uint32Array; primParams: Float32Array;
    bounds: Float32Array; cameraViewProjection: Float32Array;
  }
  export function deriveLightGroups(input: LightGroupsInput): LightGroups;
  export function receiverLayer(mask: number): number;   // lowest bit, 0 → 0
  ```

- [ ] **Step 1: Write the failing tests** (`light-groups.test.ts`). Build `renderMeta`/`primParams`/`bounds` with a helper:
  ```ts
  const LIGHT = 6, CAST = 1 << 9, RECV = 1 << 10;
  type E = { kind: 'light' | 'drawable'; mask?: number; flags?: number; type?: number; shadow?: number; x?: number; r?: number };
  function scene(es: E[]) {
    const n = es.length, renderMeta = new Uint32Array(n * 2), primParams = new Float32Array(n * 8), bounds = new Float32Array(n * 4);
    es.forEach((e, i) => {
      const m = (e.mask ?? (e.kind === 'light' ? 0xffff : 0)) << 16;
      renderMeta[i * 2 + 1] = (e.kind === 'light' ? LIGHT | ((e.type ?? 0) << 11) : e.flags ?? 0) | m;
      primParams[i * 8 + 7] = e.shadow ?? 0;
      bounds[i * 4] = e.x ?? 0; bounds[i * 4 + 3] = e.r ?? 1;
    });
    const vp = new Float32Array([0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); // view x,y ∈ [-10,10]
    return { entityCount: n, renderMeta, primParams, bounds, cameraViewProjection: vp };
  }
  ```
  Tests:
  - "default scene: one group, one set" — `[light shadow 1, drawable CAST|RECV mask 0]` → `groups = [{layers: 1, sdfSet: 0}]`, `sdfSets = [{occluderLayers: 1}]`, `layerToGroup = [0, 0]`.
  - "no shadowed light: no SDF set" — the same with `shadow 0` → `sdfSet -1`, `sdfSets []`.
  - "a light on layer 1 splits layers 0 and 1" — lights `0b01` and `0b10`, receivers mask `0b01` and `0b10` → 2 groups; `layerToGroup[0] === (0 | 1 << 4)`.
  - "same lights, different casters: two sets" — one light 0xffff with shadow, receivers on layers 0 and 1, occluders `0b01` and `0b10` → 2 groups, 2 sets.
  - "same lights and casters on two layers: one group" — receivers on 0 and 1, one occluder mask 0 → one group with `layers 0b11`.
  - "casters do not split layers no shadowed light reaches" — the same as the "two sets" case, but with shadow 0 → 1 group, no set.
  - "mask 0 per role" — occluder mask 0 → `occluderMasks` contains 0xffff; a light with explicit mask 0 lights nothing (layer 0 key has no lit bit, so group 0 still exists but `lightMasks` is `[0]`).
  - "receiver on its lowest bit, flagged when multi-bit" — receiver `0b110` → layer 1, `multiBitReceiver: true`.
  - "frustum: a light out of view does not split groups; a global light always counts" — a light at x = 100, r = 5, mask 0b10 → ignored; a light with type 3 (global), r = 3.4e38, mask 0b10 → counted.
  - "frustum is conservative at the edge" — a light at x = 10 + 5.02, r = 5 is kept (margin), one at x = 10 + 5.2 is dropped.
  - "occluders out of view do not create sets" — occluder at x = 100, mask 0b10 → 1 set.
  - "a light on an unoccupied layer changes nothing" — light 0b1000 + default scene → still 1 group (`lightMasks` gains the value; groups are keyed per occupied layer).
  - "zero receivers: one fictitious group" → `groups = [{layers: 1, sdfSet: -1}]`.
  - "16 layers, 16 groups, 16 sets" — for b in 0..15: receiver `1 << b` with CAST, light `1 << b` with shadow → 16 groups, 16 sets, `layerToGroup = [0x76543210, 0xfedcba98]`.
  - `receiverLayer(0) === 0`, `receiverLayer(0b1000) === 3`.

- [ ] **Step 2: Run to verify they fail.** `npx --prefix ts vitest run --root ts src/render/light-groups.test.ts` → "Cannot find module './light-groups'".

- [ ] **Step 3: Implement `light-groups.ts`:**
  ```ts
  import { extractFrustumPlanes, isSphereInFrustum } from '../camera';

  const LIGHT2D = 6, CASTS = 1 << 9, RECEIVES = 1 << 10;
  const POINT = 0, SPOT = 1;
  const MARGIN_SCALE = 1.01, MARGIN_ADD = 1e-3;

  export function receiverLayer(mask: number): number {
    return mask === 0 ? 0 : 31 - Math.clz32(mask & -mask);
  }

  export function deriveLightGroups(input: LightGroupsInput): LightGroups {
    const { entityCount: n, renderMeta, primParams, bounds } = input;
    const planes = extractFrustumPlanes(input.cameraViewProjection);
    const inView = (i: number) => isSphereInFrustum(planes, bounds[i * 4], bounds[i * 4 + 1], bounds[i * 4 + 2],
      bounds[i * 4 + 3] * MARGIN_SCALE + MARGIN_ADD);
    const lightMasks = new Set<number>(), occluderMasks = new Set<number>();
    let shadowedLayers = 0, receiverLayers = 0, multiBitReceiver = false;
    for (let i = 0; i < n; i++) {
      const w = renderMeta[i * 2 + 1];
      const mask = w >>> 16;
      if ((w & 0xff) === LIGHT2D) {
        if (!inView(i)) continue;
        lightMasks.add(mask);
        const type = (w >>> 11) & 7;
        if ((type === POINT || type === SPOT) && Math.min(Math.max(primParams[i * 8 + 7], 0), 1) > 0) shadowedLayers |= mask;
        continue;
      }
      if ((w & CASTS) && inView(i)) occluderMasks.add(mask === 0 ? 0xffff : mask);
      if (w & RECEIVES) {
        receiverLayers |= 1 << receiverLayer(mask);
        if (mask & (mask - 1)) multiBitReceiver = true;
      }
    }
    const lights = [...lightMasks], occluders = [...occluderMasks];
    const groups: LightGroup[] = [], sdfSets: Array<{ occluderLayers: number }> = [];
    const groupByKey = new Map<string, number>(), setByKey = new Map<string, number>();
    const table = [0, 0];
    for (let b = 0; b < 16; b++) {
      if (!((receiverLayers >>> b) & 1)) continue;
      let lightKey = '';
      for (const m of lights) lightKey += (m >>> b) & 1;
      let casterKey = '-';
      if ((shadowedLayers >>> b) & 1) { casterKey = ''; for (const o of occluders) casterKey += (o >>> b) & 1; }
      const key = `${lightKey}|${casterKey}`;
      let g = groupByKey.get(key);
      if (g === undefined) {
        let set = -1;
        if (casterKey !== '-') {
          set = setByKey.get(casterKey) ?? -1;
          if (set === -1) { set = sdfSets.length; setByKey.set(casterKey, set); sdfSets.push({ occluderLayers: 0 }); }
        }
        g = groups.length; groupByKey.set(key, g); groups.push({ layers: 0, sdfSet: set });
      }
      groups[g].layers |= 1 << b;
      if (groups[g].sdfSet >= 0) sdfSets[groups[g].sdfSet].occluderLayers |= 1 << b;
      table[b >> 3] |= g << ((b & 7) * 4);
    }
    if (groups.length === 0) groups.push({ layers: 1, sdfSet: -1 });
    return { groups, sdfSets, layerToGroup: [table[0] >>> 0, table[1] >>> 0], multiBitReceiver,
      lightMasks: lights, occluderMasks: occluders };
  }
  ```
  Use `>>> 0` everywhere a nibble can reach bit 31.

- [ ] **Step 4: Run the tests** → PASS. Then run the whole suite: `npm --prefix ts test`.

- [ ] **Step 5: Commit.** `feat(#17): deriveLightGroups — gruppi di layer automatici come i batch di Unity`

---

### Task 2: Profiler stages inside one graph pass

**Files:**
- Modify: `ts/src/render/render-pass.ts` (`RenderPass`)
- Modify: `ts/src/render/render-graph.ts` (`render()`)
- Modify: `ts/src/render/gpu-profiler.ts` (`consume()`, default capacity)
- Test: `ts/src/render/render-graph.test.ts`, `ts/src/render/gpu-profiler.test.ts`

**Interfaces:**
- Produces:
  - `RenderPass.profileStages?(frame: FrameState): readonly string[]`;
  - `RenderPass.execute(encoder, frame, resources, mark?: (encoder: GPUCommandEncoder) => void)`;
  - the timings of a staged pass are named `${pass}/${stage}` and summed within a frame.

- [ ] **Step 1: Failing tests.**
  - `render-graph.test.ts`, "a staged pass marks its own stages": a pass with `profileStages: () => ['a', 'b', 'a']` calls `mark(encoder)` three times.
    - The profiler double records `beginFrame(['p0', 'staged/a', 'staged/b', 'staged/a', 'p2'])`.
    - The graph does not mark before a staged pass.
  - `gpu-profiler.test.ts`, "repeated names in one frame are summed": names `['x/a', 'x/b', 'x/a']` with stamps `[0, 1e6, 3e6, 6e6]` give `x/a` = 1 + 3 = 4 ms and `x/b` = 2 ms.
  - `gpu-profiler.test.ts`, "default capacity is 256 markers": `beginFrame(Array(255).fill('p'))` returns true.

- [ ] **Step 2:** run them → FAIL.

- [ ] **Step 3: Implement.**
  - In `RenderGraph.render`, build `names` by expanding each staged pass's `profileStages(frame)` into `${name}/${stage}`.
  - While executing, call `profiler.mark` before each **unstaged** pass. Hand a staged pass `measuring ? (e) => this.profiler!.mark(e) : undefined` as its fourth argument.
  - In `GpuProfiler.consume`, accumulate each frame's deltas into a `Map<string, number>` and push one sample per name.
  - Change `constructor(device, maxPasses = 256)`.

- [ ] **Step 4:** run the tests → PASS, then the whole suite.

- [ ] **Step 5: Commit.** `feat(render): stadi di profiling dentro un pass, capacità 256 marker`

---

### Task 3: `CameraUniform` at 80 B and the occluder-layer test in the six primitive shaders

**Files:**
- Modify: `ts/src/shaders/{basic,line,msdf-text,bezier,gradient,box-shadow}.wgsl`
- Modify: `ts/src/render/primitive-bindings.ts` (binding 0 gets `minBindingSize: 80`)
- Modify: `ts/src/render/passes/forward-pass.ts` (camera buffer 80 B, writes VP + `occluderLayers` 0)
- Test: `ts/src/render/passes/occluder-seed-pass.test.ts` (the shader text checks move to Task 5), `ts/src/render/passes/forward-pass.test.ts`, `ts/src/shaders/uniform-layout.test.ts` (unchanged, must stay green)

- [ ] **Step 1: Failing tests** (in `forward-pass.test.ts`, block "primitive shaders: occluder layers"). For each of the six shaders:
  - `CameraUniform` matches `/struct CameraUniform\s*\{\s*viewProjection: mat4x4f,\s*occluderLayers: u32,/`;
  - the vertex stage uses `castsInto(` together with `camera.occluderLayers`;
  - `fn castsInto` normalises mask 0 to 0xFFFF (`select(`…`0xFFFFu`).

  Also:
  - `primitiveGroup0LayoutEntries()[0].buffer.minBindingSize === 80`;
  - ForwardPass creates its camera buffer with `size: 80` (mock `createBuffer` records the size of the UNIFORM buffers).

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: Implement.** In each shader, replace the struct with:
  ```wgsl
  struct CameraUniform {
      viewProjection: mat4x4f,
      // The layers the occluder set being seeded shadows (OccluderSeedStage);
      // 0 in ForwardPass, which never reads it.
      occluderLayers: u32,
      _pad0: u32,
      _pad1: u32,
      _pad2: u32,
  };
  ```
  Add after `CASTS_SHADOW_BIT`:
  ```wgsl
  // Whether an entity is in the occluder set being seeded: it casts, and its
  // mask (renderMeta bits 16-31, 0 = every layer) meets the set's layers.
  fn castsInto(meta1: u32, layers: u32) -> bool {
      let mask = select(meta1 >> 16u, 0xFFFFu, (meta1 >> 16u) == 0u);
      return (meta1 & CASTS_SHADOW_BIT) != 0u && (mask & layers) != 0u;
  }
  ```
  Change the vertex test to `if (OCCLUDER_PASS && !castsInto(renderMeta[entityIdx * 2u + 1u], camera.occluderLayers)) {`.

  ForwardPass:
  - `cameraBuffer` becomes `size: 80`;
  - `prepare` writes `new Float32Array(20)` with the VP in 0..15 and zeros after.

- [ ] **Step 4:** run → PASS, plus `uniform-layout.test` and the whole suite.

- [ ] **Step 5: GPU check.** Reload the harness (AMD initScript): 0 WebGPU messages on the Lighting tab and the Primitives tab.

- [ ] **Step 6: Commit.** `feat(#17): CameraUniform a 80 B e test dei layer occluder nei sei primitivi`

---

### Task 4: `LightAccumStage` + the per-group light filter

**Files:**
- Rename: `ts/src/render/passes/light-accum-pass.ts` → `light-accum-stage.ts` (and its test)
- Modify: `ts/src/shaders/light-accum.wgsl` (`_pad1` becomes `groupLayers`; `vs_main` filter)

**Interfaces:**
- Produces:
  ```ts
  export class LightAccumStage {
    static SHADER_SOURCE: string;
    setup(device: GPUDevice, resources: ResourcePool): void;
    /** Writes one 256-byte slice per group; call once per frame. */
    prepare(device: GPUDevice, frame: FrameState, groups: readonly LightGroup[]): void;
    /** One render pass: clear `target` to ambient, draw the Light2D buckets filtered to group g. */
    encode(encoder: GPUCommandEncoder, g: number, target: GPUTextureView, sdf: GPUTextureView, frame: FrameState): void;
    destroy(): void;
  }
  export const LIGHT2D_ARG_SLOTS: number[]; export const LIGHT_SOURCE_FRACTION: number; export const SLICE = 256;
  ```

- [ ] **Step 1: Failing tests** (adapt the existing LightAccumPass tests):
  - slices: `prepare` with 3 groups writes one buffer of `3 * 256` bytes, with `groupLayers` (u32 at slice offset 76) equal to each group's layers;
  - `encode(g)` binds a bind group whose binding 0 has `offset: g * 256, size: 80`;
  - it clears `target` to ambient;
  - it draws `[240, 260]`;
  - bind groups are cached per (g, sdf view), so the same inputs give the same object;
  - WGSL: `groupLayers: u32` in `LightUniform`, plus a degenerate vertex when `((renderMeta[e * 2u + 1u] >> 16u) & u.groupLayers) == 0u`.

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: Implement.**
  - The uniform buffer grows to `max(1, G) * 256` (grow-only).
  - `prepare` fills each slice: VP, steps, hardness, `LIGHT_SOURCE_FRACTION`, `groupLayers`.
  - `encode` = the old `execute`, with an explicit `target`/`sdf` and `setBindGroup(0, cached(g, sdf))`.
  - The vertex filter goes at the top of `vs_main`, before `lightType(e)`:
    ```wgsl
    if (((renderMeta[e * 2u + 1u] >> 16u) & u.groupLayers) == 0u) {
        out.position = vec4f(0.0, 0.0, 0.0, 1.0);
        return out;
    }
    ```

- [ ] **Step 4:** run → PASS, plus `uniform-layout.test`.

- [ ] **Step 5: Commit.** `refactor(#17): LightAccumStage — accumulo per gruppo con slice da 256 byte`

---

### Task 5: `OccluderSeedStage` + `SdfChainStage`

**Files:**
- Rename: `occluder-seed-pass.ts` → `occluder-seed-stage.ts` (keeps `halfResolution`); `sdf-jfa-pass.ts` → `sdf-chain-stage.ts` (and their tests)
- Modify: `ts/src/render/passes/jfa-pass.ts` (`JfaIterationPass` keeps only `JFAPass`'s needs; the SDF chain stops using it)

**Interfaces:**
- Produces:
  ```ts
  export class OccluderSeedStage {
    constructor(shaderSources: Record<number, string>);
    setup(device, resources): void;
    prepare(device, frame, sets: ReadonlyArray<{ occluderLayers: number }>): void;   // 256-byte camera slices, 80 B each
    encode(encoder, s: number, target: GPUTextureView, resources: ResourcePool): void; // clear 0, opaque buckets, slice s
    destroy(): void;
  }
  export class SdfChainStage {
    static SHADER_SOURCE: string;
    static chainLength(maxDim: number): number;           // 1 + iterationsForDimension(maxDim)
    static steps(maxDim: number): number[];               // [1, 2^(m-1), …, 1]
    setup(device, resources): void;                        // two pipelines: LOAD_PASS 1 and 0
    prepare(device, width: number, height: number): void;  // one 256-byte param slice per step
    /** Floods `seed` through `a`/`b`; returns the view holding the final SDF. */
    encode(encoder, seed: GPUTextureView, a: GPUTextureView, b: GPUTextureView): GPUTextureView;
    destroy(): void;
  }
  ```

- [ ] **Step 1: Failing tests.**
  - Seed: `prepare` with 2 sets writes 2 slices at offsets 0 and 256, each with `occluderLayers` at byte 64; `encode(s)` binds group 0 with the camera at offset `s * 256`, size 80.
  - Chain:
    - `steps(400)` gives `[1, 256, 128, 64, 32, 16, 8, 4, 2, 1]`;
    - `encode` issues `chainLength` render passes alternating a/b (the first reads `seed`), and returns b when the length is even, a when odd;
    - the first pass uses the `LOAD_PASS = 1` pipeline, the others `LOAD_PASS = 0`;
    - the param slices hold stepSize and 1/width, 1/height.
  - Keep the existing text tests (`textureLoad`, `LOAD_PASS` override, `fs_occluder` in every shader, `CASTS_SHADOW_BIT` = Rust).

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: Implement** both stages from the existing pass code:
  - seed: the pipelines of `OccluderSeedPass.setup`, and a camera buffer of `max(1, C) * 256` bytes with one group-0 bind group per slice, cached;
  - chain: the pipeline and params of `JfaIterationPass`, with one bind group per (step, input view), cached.

- [ ] **Step 4:** run → PASS.

- [ ] **Step 5: Commit.** `refactor(#17): OccluderSeedStage e SdfChainStage — stadi con slice per set`

---

### Task 6: `LightGroupsPass` — the node

**Files:**
- Create: `ts/src/render/passes/light-groups-pass.ts`
- Test: `ts/src/render/passes/light-groups-pass.test.ts`
- Modify: `ts/src/render/render-pass.ts` (`FrameState.lightGroups?: LightGroups`)

**Interfaces:**
- Consumes: Tasks 1, 2, 4 and 5.
- Produces: `class LightGroupsPass implements RenderPass`.
  - `name = 'light-groups'`, `optional = true`, `writes = ['light-buffer']`.
  - `reads = ['visible-indices', 'entity-transforms', 'indirect-args', 'render-meta', 'tex-indices', 'prim-params']`.
  - `constructor(shaderSources: Record<number, string>)`.
  - `profileStages(frame)` gives `['seed', 'sdf', 'accum'] × sets`, plus `['accum']` when any group has `sdfSet -1`.
  - The pool view `light-buffer` is a `2d-array` view.

- [ ] **Step 1: Failing tests** (device mock records textures, views, render passes in order, and the stages' calls):
  - "set-major": 2 sets, groups `[{sdfSet: 0}, {sdfSet: 1}, {sdfSet: 0}, {sdfSet: -1}]` → encode order: seed0, chain0, accum0, accum2, seed1, chain1, accum1, accum3 (with the placeholder SDF).
  - "reuses one seed and one ping-pong pair": the same three texture objects across sets.
  - "light-buffer is a 2d-array with one layer per group":
    - `depthOrArrayLayers === 4`;
    - `textureBindingViewDimension === '2d-array'`;
    - each accum target is a view with `baseArrayLayer = g`, `dimension '2d'`, `arrayLayerCount 1`.
  - "zero groups still clears one layer": with `lightGroups` absent, the default is 1 group of every layer with set 0 → one layer.
  - "no set: no seed or chain".
  - "group count oscillates without reallocation": G 1 → 3 → 1 → 3 creates the array twice (1 layer, then 3), never shrinks, and reuses the layer views.
  - "resize recreates every layer view": all three textures and the views are recreated, and the pool's `light-buffer` changes.
  - "marks its stages": with `mark`, it is called 3 × sets (+1) times, before each stage.

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: Implement.**
  - `prepare` passes `groups`/`sets` to the stages and the size to the chain.
  - `execute(encoder, frame, resources, mark?)`:
    1. ensure the textures (`halfResolution`, grow-only on layers);
    2. for each set s: `mark?.(encoder)`, then seed; `mark?.(encoder)`, then chain; `mark?.(encoder)`, then accumulate each group of s into `layerView(g)` with the final view;
    3. if any group has `sdfSet -1`: `mark?.(encoder)`, then accumulate those groups with the `noOccluder` view (a 1×1 JFA_FORMAT texture cleared to 0 at setup through `writeTexture`).
  - The default `LightGroups` when `frame.lightGroups` is undefined: `{groups: [{layers: 0xffff, sdfSet: 0}], sdfSets: [{occluderLayers: 0xffff}], layerToGroup: [0, 0], …}`.

- [ ] **Step 4:** run → PASS.

- [ ] **Step 5: Commit.** `feat(#17): LightGroupsPass — un nodo set-major, light buffer 2d-array per gruppo`

---

### Task 7: ForwardPass group 2 → `texture_2d_array` + layer→group table

**Files:**
- Modify: `ts/src/render/passes/forward-pass.ts`, `ts/src/shaders/basic.wgsl`, `ts/src/shaders/gradient.wgsl`
- Test: `ts/src/render/passes/forward-pass.test.ts`

- [ ] **Step 1: Failing tests.**
  - The group-2 layout has binding 0 `texture.viewDimension === '2d-array'`.
  - The placeholder is a 1-layer texture with a `2d-array` view.
  - `prepare(frame with lightGroups.layerToGroup = [0x10, 0])` writes `[enabled, 0x10, 0, 0]` into the 16-byte lighting uniform.
  - Without `lightGroups`, it writes `[enabled, 0, 0, 0]`.
  - WGSL, for basic and gradient:
    - `var lightBuffer: texture_2d_array<f32>`;
    - `LightingUniform` has `groupTableLo`/`groupTableHi`;
    - `fs_main` calls `lightGroupOf(`;
    - the sample is `textureSampleLevel(lightBuffer, lightSampler, in.screenUV, lightGroupOf(`;
    - `lightGroupOf` uses `firstTrailingBit`.

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: Implement.** In the shaders:
  ```wgsl
  struct LightingUniform {
      enabled: u32,
      // layer → light-buffer layer, 4 bits per layer: layers 0-7 here, 8-15 below.
      groupTableLo: u32,
      groupTableHi: u32,
      _pad0: u32,
  };
  @group(2) @binding(0) var lightBuffer: texture_2d_array<f32>;

  // A receiver belongs to ONE layer, the lowest bit of its mask (0 = layer 0).
  fn lightGroupOf(mask: u32) -> u32 {
      let layer = select(firstTrailingBit(mask), 0u, mask == 0u);
      let word = select(lighting.groupTableLo, lighting.groupTableHi, layer >= 8u);
      return (word >> (4u * (layer % 8u))) & 0xFu;
  }
  ```
  In `fs_main`: `let meta1 = renderMeta[in.entityIdx * 2u + 1u];`, then sample with `textureSampleLevel(lightBuffer, lightSampler, in.screenUV, lightGroupOf(meta1 >> 16u), 0.0)`.

  ForwardPass: the placeholder becomes `createTexture({size: {width: 1, height: 1, depthOrArrayLayers: 1}, textureBindingViewDimension: '2d-array'})` with a `createView({dimension: '2d-array'})` view. `prepare` writes the uniform every frame.

- [ ] **Step 4:** run → PASS.

- [ ] **Step 5: Commit.** `feat(#17): ForwardPass legge il layer del proprio gruppo dal light buffer 2d-array`

---

### Task 8: Graph and renderer integration

**Files:**
- Modify: `ts/src/renderer.ts`, `ts/src/render/graph-requests.ts` (drop `rebuild`), `ts/src/render/graph-assembly.test.ts`, `ts/src/render/graph-host.test.ts`, `ts/src/render/graph-requests.test.ts`

- [ ] **Step 1: Failing tests.**
  - `graph-assembly.test.ts` "lighting": the lit chain is `[new LightGroupsPass({})]`, so the order has `light-groups` before `forward`.
  - `graph-host.test.ts`: the mock lighting factory returns a pass named `light-groups` writing `light-buffer`; the clash tests use `light-groups`.
  - `graph-requests.test.ts`: delete the `rebuild` describe block; assert `'rebuild' in GraphRequests.prototype === false`.

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: Implement** in `renderer.ts`:
  - **Delete:** the imports of the three old passes; the SDF ping-pong state and functions (`sdfPasses`, `sdfTextureA/B`, `sdfChain`, `ensureSdfChainFits`, `ensureSdfTextures`, `updateSdfTextureViews`); the lighting branch and `sdfChainLength` param of `prepareMode`; the `sdfPasses` line and the `ensureSdfChainFits` calls in `onSwap` and in the resize branch.
  - **Wire the node:** `lighting: () => [new LightGroupsPass(ForwardPass.SHADER_SOURCES)]`.
  - **Shader slots:**
    - `SdfChainStage.SHADER_SOURCE` and `LightAccumStage.SHADER_SOURCE` are set at init;
    - the `sdf-jfa` and `light-accum` slots probe `() => new LightGroupsPass(ForwardPass.SHADER_SOURCES)`;
    - the forward slot probes `[new ForwardPass(), new LightGroupsPass(ForwardPass.SHADER_SOURCES)]`.
  - **In `render()`:** when `host.mode.lighting`, set `frameState.lightGroups = deriveLightGroups(frameState)`. If `multiBitReceiver` and it has not warned yet, `console.warn` once: `[Hyperion] A light receiver has more than one layer bit: it belongs to its lowest one (lightLayers()).`
  - **`graph-requests.ts`:** delete `rebuild()`.

- [ ] **Step 4:** run the whole suite and `npx --prefix ts tsc --noEmit -p ts` → green.

- [ ] **Step 5: GPU check** (AMD):
  - the Lighting tab renders exactly as before, with 0 WebGPU messages;
  - bloom/outlines toggles, resize, and backend off → on all work;
  - read `getGpuTimings()`: the `light-groups/seed|sdf|accum` entries are present.

- [ ] **Step 6: Commit.** `feat(#17): il grafo illuminato usa LightGroupsPass, esce la catena SDF del renderer`

---

### Task 9: `engine.lighting.groups` + docs of the mask

**Files:**
- Modify: `ts/src/lighting-api.ts` (`groups` getter, `_init(producer, bridge, viewProjection?)`), `ts/src/hyperion.ts` (pass `() => this.camera.viewProjection`), `ts/src/entity-handle.ts` (`lightLayers()`/`LightOptions.layers` docs), `crates/hyperion-core/src/components.rs` (LightFlags doc only)
- Test: `ts/src/lighting-api.test.ts`

- [ ] **Step 1: Failing test.** A bridge whose `latestRenderState` holds two receivers (layers 0 and 1) and lights `0b01`/`0b10` gives `api.groups.groups.length === 2`. Before `_init`, `groups` is `null`.

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: Implement:**
  ```ts
  get groups(): LightGroups | null {
    const rs = this.bridge?.latestRenderState;
    if (!rs || !this.viewProjection) return null;
    return deriveLightGroups({ ...rs, cameraViewProjection: this.viewProjection() });
  }
  ```
  Rewrite the `lightLayers()` doc: the three roles, mask 0 per role, lowest bit for receivers, and "each distinct caster set among shadowed layers costs a full SDF flood (≈ 1.8 ms at 1080p on an iGPU); read `engine.lighting.groups` to see why".

- [ ] **Step 4:** run → PASS; `cargo test -p hyperion-core` stays green (doc change only).

- [ ] **Step 5: Commit.** `feat(#17): engine.lighting.groups e la semantica della maschera documentata`

---

### Task 10: GPU validation, measurements, demo check

**Files:**
- Modify: `ts/src/demo/lighting.ts` (the "Light layers" check becomes real)
- Modify: `docs/plans/2026-08-04-phase17-lighting-2d-design.md` §13.2 (numbers)

- [ ] **Step 1:** in the demo, add a blue light on layer 1 (`lightLayers(0b10)`), a lit sprite on layer 1 and a wall with `lightLayers(0b01)`. The check reads `engine.lighting.groups` after 3 frames and expects 2 groups and 2 sets.
- [ ] **Step 2: GPU readbacks** (Chrome, AMD initScript, harness Mode B):
  1. A layer-1 light does not light a layer-0 sprite: screenshot luma at the sprite equals the ambient-only value.
  2. A wall with mask 0b01 shadows the layer-0 floor and not the layer-1 sprite.
  3. Default scene: the same screenshot before/after (pixel difference 0 in a static frame; use `e.pause()`).
  4. Toggling `lightLayers` at runtime changes `groups` without a graph rebuild (the `renderer.graph` object identity is unchanged).
  5. Resize.
  6. 0 WebGPU messages.
- [ ] **Step 3: Measure** at 1920×1081 with `enableGpuProfiling()`: `light-groups/*` with 1 set / 1 group, 2 sets / 2 groups, and 1 set / 2 groups. Write the numbers into design §13.2.
- [ ] **Step 4: Commit.** `feat(#17): demo "Light layers" reale e misure dei gruppi di luce`

---

### Task 11: Docs and adversarial review

- [ ] **Step 1:** update CLAUDE.md:
  - the module rows: `light-groups.ts`, `light-groups-pass.ts`, the three `*-stage.ts`, ForwardPass, renderer, gpu-profiler, render-pass;
  - the shader rows;
  - the gotchas:
    - mask semantics;
    - rendering into an array layer;
    - `CameraUniform` at 80 B in six shaders;
    - staged profiling;
    - no graph rebuild on resize (drop `ensureSdfChainFits`);
    - the "light mask has no visual effect" gotcha is now obsolete;
  - test counts and status.

  Update design §7.3/§7.4 and the plan checkboxes.
- [ ] **Step 2:** run `scripts/preflight.sh --full` → green.
- [ ] **Step 3:** run the adversarial review workflow over the task range: 4 dimensions (WebGPU validity, grouping semantics, stage orchestration, docs) plus one verifier per finding. Fix what is confirmed, TDD first.
- [ ] **Step 4:** commit and push.
