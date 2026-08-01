---
name: new-primitive
description: Add a new render primitive type (shader + pipeline + API). Use when adding a new RenderPrimitiveType to the engine.
---

Add a new RenderPrimitiveType to the Hyperion Engine. The user should provide: primitive name and SDF/geometry approach.

## Prerequisites

Before starting, read these files to understand the current primitive type setup:
- `ts/src/render/passes/forward-pass.ts` (SHADER_SOURCES map, RenderPrimitiveType enum)
- `ts/src/shaders/basic.wgsl` (reference bind group layout)
- `ts/src/entity-handle.ts` (fluent API pattern)
- `ts/src/render/passes/cull-pass.ts` (indirect args count)

## Checklist

1. **Create WGSL shader** at `ts/src/shaders/{name}.wgsl`:
   - Copy @group(0) layout exactly from basic.wgsl (camera, transforms, visibleIndices, texIndices, renderMeta, primParams)
   - Copy @group(1) layout exactly from basic.wgsl (tier0-tier3, sampler, ovf0-ovf3)
   - Implement vertex + fragment entry points
   - Use `textureSampleLevel()` (NOT `textureSample()`) in vertex/compute for macOS/Metal
   - Add `?raw` import in forward-pass.ts

2. **Register in ForwardPass** (`ts/src/render/passes/forward-pass.ts`):
   - Add new value to `RenderPrimitiveType` enum (next available integer)
   - Add entry to `SHADER_SOURCES` map: `[RenderPrimitiveType.{Name}, shaderSource]`

3. **Extend EntityHandle** (`ts/src/entity-handle.ts`):
   - Add fluent method (e.g., `.myPrimitive()`) that sets RenderPrimitive component
   - Use `this._ring.setPrimitive(this._id, RenderPrimitiveType.{Name})`
   - If primitive uses PrimParams, add parameter mapping to `prim-params-schema.ts`

4. **Update cull shader indirect args** if total primitive types exceeds 6:
   - `ts/src/shaders/cull.wgsl`: grow the `array<DrawIndirectArgs, N>` declaration — it is
     currently 24 entries (6 types x 2 material buckets x 2 blend modes), 480 bytes
   - `ts/src/render/passes/cull-pass.ts`: update the buffer allocation to match
   - Update the "Indirect args are 24 entries (480 bytes)" gotcha in CLAUDE.md

5. **Export from barrel** (`ts/src/index.ts`):
   - Re-export new RenderPrimitiveType value if public

6. **Add tests**:
   - Forward pass test in `ts/src/render/passes/forward-pass.test.ts`
   - EntityHandle fluent method test in `ts/src/entity-handle.test.ts`

7. **Update documentation**:
   - CLAUDE.md: Architecture tables (Shaders, Components), Gotchas (primitive type count)
   - Add primitive to "Types: 0=Quad, 1=Line, ..." list

## Validation

```bash
scripts/preflight.sh
```

That script is the single definition of "validated" — do not reconstruct the command list
here. See the `/validate` skill for what it covers.

Then verify visually, which nothing automated can do — WebGPU returns null from
`requestAdapter()` headless, so a green preflight says nothing about whether the new
primitive draws:
```bash
cd ts && npm run dev
```

Run the **`wgsl-validator`** agent as well: every primitive shader must declare an
identical bind group layout, including bindings it never reads.
