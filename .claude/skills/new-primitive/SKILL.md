---
name: new-primitive
description: Add a new render primitive type (library piece + composer registration + API). Use when adding a new RenderPrimitiveType to the engine.
---

Add a new RenderPrimitiveType to the Hyperion Engine. The user should provide: primitive name and SDF/geometry approach.

Since phase 5b a primitive is not a shader file: it is a LIBRARY piece that the TypeScript
composer (`ts/src/render/primitive-shaders.ts`) joins to the shared prelude, once as its own
per-type module (opaque pipeline + occluder pipeline) and once as a `case` of the uber module
(the one transparent pipeline). A piece never compiles alone.

## Prerequisites

Read these first:
- `ts/src/shaders/primitives/prelude.wgsl` — the bindings (groups 0/1/2), `CameraUniform`, `VertexOutput`, `OCCLUDER_PASS`/`castsInto`, the lighting block and the helpers (`culledVertex`, `finishVertex`, `unitQuadVertex`, `sampleTier`, `sampleTierOrWhite`, `occluderSeed`, `applyLighting`)
- `ts/src/shaders/primitives/quad.wgsl` (the smallest library) and `line.wgsl` (its own vertex expansion and occluder rule)
- `ts/src/render/primitive-shaders.ts` — `PRIMITIVE_LIBRARIES` and the three compose functions
- `ts/src/entity-handle.ts` — `RenderPrimitiveType` (mirrored in `ts/src/prim-params-schema.ts`) and the fluent API pattern
- `ts/src/render/passes/cull-pass.ts` and `ts/src/shaders/cull.wgsl` — `NUM_PRIM_TYPES`

## Checklist

1. **Library** `ts/src/shaders/primitives/{name}.wgsl`:
   - NO `@group`/`@binding`, no entry point, no directive, and never the text `fn fs_occluder` (not even in a comment): the prelude and the composer own them;
   - EVERY top-level name carries the library's prefix (`{p}_`); no local `let`/`var`/`const` or parameter reuses a prelude global's name (WGSL would shadow it silently);
   - exactly `{p}_vs(position: vec3f, entityIdx: u32) -> VertexOutput`, `{p}_fs(in: VertexOutput) -> vec4f` and `{p}_occluder(in: VertexOutput) -> vec4f`, with the coverage in `{p}_shade(in: VertexOutput) -> vec4f`, reached by both `{p}_fs` and `{p}_occluder`;
   - `{p}_vs` ends in `finishVertex(...)`, or is `unitQuadVertex(...)` for a unit quad; `{p}_occluder` is usually `return occluderSeed(in, {p}_shade(in).a);`;
   - lighting only through `applyLighting(in, color)`, only from `{p}_fs`, and only if the type is lit — never from `{p}_shade`/`{p}_vs` (the occluder pipelines have no group 2);
   - derivatives (`fwidth`, `dpdx`) before any branch of `{p}_shade`: the per-type module compiles under the strict uniformity analysis;
   - sample the tiers with `sampleTierOrWhite(in)` (packed index 0 answers white) unless the texture is data, as msdf's atlas (raw `sampleTier`); `textureSampleLevel`, never `textureSample`, outside fragment code.
2. **Register** it in `PRIMITIVE_LIBRARIES` (`ts/src/render/primitive-shaders.ts`): `{ type, name, prefix, lit }`. That derives its per-type module in `ForwardPass.SHADER_SOURCES`, its `case` in the uber `vs_main`/`fs_main`, and `LIT_PRIMITIVE_TYPES`.
3. **renderer.ts**: the `?raw` import of the piece next to the others, its entry in `primitivePieces.libraries`, a piece slot in `shaderSlots` (the same probe as the other pieces, `usedBy: inEveryMode`), and its `import.meta.hot.accept` block feeding the `PieceReloadCollector`. A piece without its own accept turns every edit into a FULL page reload (a full reload: harness state is lost; on the Fedora box it also loses the low-power initScript and the device).
4. **Type id**: Light2D (6) is the last type, and `cull.wgsl`, `deriveLightGroups` and the uber `vs_main` clamp anything past it to 6 (a light). A new drawable type therefore means moving Light2D: `NUM_PRIM_TYPES` in `cull.wgsl` and `cull-pass.ts` (indirect args = NUM_PRIM_TYPES × 2 × 2 entries of 20 B; the "Indirect args are 28 entries" gotcha in CLAUDE.md), `PRIM_TYPE_LIGHT2D` in Rust, `LIGHT2D_ARG_SLOTS`, the gather's bucket range (`FIRST_TRANSPARENT_ARG`, `GATHER_REGIONS` in `transparent-sort-constants.ts` and in the WGSL) and the uber's clamp in the composer.
5. **EntityHandle** (`ts/src/entity-handle.ts`): the `RenderPrimitiveType` value and a fluent method that sends `setRenderPrimitive` and its params; `PRIM_PARAMS_SCHEMA` in `prim-params-schema.ts`.
6. **Barrel** (`ts/src/index.ts`) if public.
7. **Tests**: the composer tests (the per-type module has `vs_main`/`fs_main`/`fs_occluder`, the uber has the new `case`, prefix and unique-name rules, group 2 reachable iff lit), `entity-handle.test.ts`, and `cull-pass.test.ts` if `NUM_PRIM_TYPES` moved.
8. **Docs**: CLAUDE.md — a library row in the Shaders table, the type list of the "Adding a new primitive type" gotcha.

## Validation

```bash
scripts/preflight.sh
```

That script is the single definition of "validated" — do not reconstruct the command list
here. See the `/validate` skill for what it covers.

Then verify on a real GPU, which nothing automated can do — WebGPU returns null from
`requestAdapter()` headless, so a green preflight says nothing about whether the new
primitive draws: the `/gpu-check` skill (also with the primitive `.transparent()`, which
draws through the uber pipeline).

Run the **`wgsl-validator`** agent as well: it composes the 7 modules and checks the
prelude-only bindings, the prefixes and the group-2 reachability.
