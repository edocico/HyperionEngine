# Phase 15 — Rapier 0.32 Spike Results

Date: 2026-03-07

## Binary Size Measurements

| # | Question | Result |
|---|---|---|
| 1 | Binary size without wasm-bindgen feature | 572KB raw / 224KB gzipped |
| 2 | Binary size with wasm-bindgen feature | N/A — feature does not exist in rapier2d 0.32 |
| 3 | After wasm-opt -O3 --strip-debug --enable-simd | 577KB raw / 225KB gzipped (no improvement — wasm-pack already runs wasm-opt in release) |
| 4 | Estimated delta vs hyperion-core | +219KB gzipped (224KB spike - 5KB wasm-bindgen overhead) |

### Size Context

- **hyperion-core baseline:** 164KB raw / 59KB gzipped
- **rapier-spike (Rapier only):** 572KB raw / 224KB gzipped
- **Estimated combined:** ~278KB gzipped (59KB + 219KB)
- **CI gate:** <200KB gzipped (current gate for hyperion-core alone)
- **Spike budget gate:** <400KB gzipped delta

## API Validation

| # | Question | Result |
|---|---|---|
| 5 | `step()` signature | 12 params: gravity (by value), params, islands, broad_phase, narrow_phase, bodies, colliders, impulse_joints, multibody_joints, ccd, query_handler, event_handler |
| 6 | Gravity type | glam `Vec2` (via `vector![].into()` — nalgebra macro to glam conversion) |
| 7 | Body rotation type | `Rot2` with `.angle()` returning `f32` |
| 8 | Body translation type | glam `Vec2` (`.x`, `.y` accessors) |
| 9 | `length_unit` field | Present on `IntegrationParameters`, settable (used `100.0` for pixel space) |
| 10 | `ChannelEventCollector` | Works with `std::sync::mpsc::channel()` on wasm32 target. Compiles and runs. |
| 11 | `wasm-bindgen` feature | **Does not exist** in rapier2d 0.32. Available features: `simd-stable`, `simd-nightly`, `parallel`, `enhanced-determinism`, `serde-serialize`, `debug-render`, `profiler`, `f32`, `dim2`, `default`, `simd-is-enabled`, `dev-remove-slow-accessors`, `debug-disable-legitimate-fe-exceptions`. No special WASM feature needed — Rapier compiles to wasm32 out of the box. |
| 12 | `KinematicCharacterController` | Compiles. Located in `rapier2d::control` (not re-exported in prelude). `::default()` works. |
| 13 | `RevoluteJointBuilder` | Compiles. `::new()` + `.local_anchor1/2()` with `point![].into()` (nalgebra to glam conversion). |
| 14 | `body.remove()` cascade | Works. `bodies.remove(handle, &mut islands, &mut colliders, &mut impulse_joints, &mut multibody_joints, true)` — cascades to colliders and joints. |

## API Divergences from Design Assumptions

1. **No `wasm-bindgen` feature:** Rapier 0.32 dropped the `wasm-bindgen` feature flag. The crate compiles to wasm32-unknown-unknown without any special feature. This simplifies our Cargo.toml.

2. **`vector![]` and `point![]` macros produce nalgebra types:** These require `.into()` to convert to glam `Vec2`/`Point`. This is a minor ergonomic cost but avoids pulling in nalgebra directly.

3. **`KinematicCharacterController` not in prelude:** Must be imported from `rapier2d::control`. Minor import path difference.

4. **Gravity by value, not reference:** `pipeline.step()` takes `gravity: Vector` not `&gravity`. Consistent with Rapier's move toward glam types.

5. **wasm-opt double-pass has no benefit:** wasm-pack already runs wasm-opt in release mode. Our additional `wasm-opt -O3 --strip-debug --enable-simd` pass produced a slightly larger binary (+5KB raw, +1KB gzipped). This is consistent with Phase 11 findings.

## Dependency Tree Highlights

Key transitive dependencies brought in by rapier2d 0.32:
- `nalgebra` 0.34 (math types, macros — but API surface uses glam)
- `parry2d` 0.26 (collision detection geometry)
- `simba` 0.9 (SIMD abstraction)
- `wide` 0.7 (portable SIMD)
- `safe_arch` 0.7 (architecture-specific SIMD)
- `spade` 2.15 (Delaunay triangulation for parry)
- `glam` 0.30 (already used by hyperion-core)
- `bitflags`, `smallvec`, `arrayvec` (utility crates, likely already shared)

## Gate Decision

**Delta: +219KB gzipped — PASS (under 400KB gate)**

- Combined estimate: ~278KB gzipped (hyperion-core 59KB + rapier delta 219KB)
- This exceeds the current CI gate of 200KB for hyperion-core alone. The CI gate (`check:wasm-size`) will need updating when Rapier is integrated.
- Actual combined binary will likely be smaller due to shared dependencies (glam, bitflags, smallvec, arrayvec are already in hyperion-core).

**Verdict: GO** — Rapier 0.32 is viable for integration. Binary size is acceptable.

## Comparison with Loro CRDT Spike (Phase 14b)

| Metric | Rapier 0.32 | Loro CRDT |
|---|---|---|
| Raw WASM | 572KB | ~1.8MB |
| Gzipped WASM | 224KB | 664KB |
| Estimated delta | +219KB | +659KB |
| Budget gate | <400KB | <120KB |
| Gate result | PASS | FAIL (5.7x over) |
| Transitive deps | ~20 | 127 |
| Feature flags | Useful (`simd-stable`, `enhanced-determinism`) | None useful for size reduction |
