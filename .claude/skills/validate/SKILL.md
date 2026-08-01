---
name: validate
description: Run the full Rust + TypeScript validation pipeline before committing
---

Run the validation pipeline from the repo root:

```bash
scripts/preflight.sh
```

That script is the single definition of what "validated" means for this repo. Do not
reconstruct the pipeline by hand — a second copy of the command list drifts from the
first, which is the same failure this repo already hit with its documentation.

Report **pass/fail per step**. The script stops at the first failure and exits non-zero,
so the last step printed is the one that broke. If everything is green, confirm ready to
commit.

## Why one `cargo test -p hyperion-core` is not enough

The script runs the whole feature matrix, plus lint and TypeScript, because a single
default invocation leaves most of the surface untouched:

- **Most of the suite is behind feature flags** (`physics-2d`, `dev-tools`,
  `physics-debug`). The default build compiles and runs the integration files in
  `crates/hyperion-core/tests/`, but `verify_physics.rs` and `verify_snapshot.rs` report
  **0 tests** — their contents are `#[cfg]`-gated away. Only the full matrix reaches them.
- **`cargo clippy` without `--all-targets` lints only the lib target**, so every test
  helper and integration file goes unlinted. The script's lint step passes `--all-targets`
  with `-D warnings`.

## The final protocol check

The last step is not a test — it is a consistency check.

Rust and TypeScript maintain **two separate command tables** with no codegen between them
(`crates/hyperion-core/src/ring_buffer.rs` and `ts/src/backpressure.ts`). When they
diverge, commands are framed with the wrong width and the stream desynchronises from that
byte onward, **silently**. Nothing in either toolchain catches it; the symptom is entities
that stop responding, which reads as a renderer bug.

The script compares `MAX_COMMAND_TYPE` across the two sides and fails if they disagree.

## `--full`

```bash
scripts/preflight.sh --full
```

Adds the release WASM builds and the binary size gates — roughly a minute more. Use it
**before a merge or a release**, not on every commit.

## What this cannot cover

WebGPU is not testable headless: `requestAdapter()` returns null, so no automated step
here exercises the render path. A green preflight says nothing about whether anything
draws. Verify rendering by hand:

```bash
cd ts && npm run dev
```
