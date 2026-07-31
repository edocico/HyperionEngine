---
name: validate-physics
description: Validate a physics change — runs the standard pipeline, then the manual checks no test can cover
---

Run the same pipeline as any other change, from the repo root:

```bash
scripts/preflight.sh
```

Report pass/fail per step. The script stops at the first failure.

## Physics is not a separate pipeline

This is the counterintuitive part: there is **no physics-specific validation command**.
`scripts/preflight.sh` already runs the entire feature matrix, including `--all-features`,
which subsumes `physics-2d` and `physics-debug`.

Running `cargo test -p hyperion-core --features physics-2d` on its own would cover
**less** than the default preflight run, not more — it misses everything gated behind
`dev-tools` and `physics-debug`. Reach for the script, not the flag.

## Manual checks — physics only

These are behavioural traps that pass every test and still break a scene. Check them by
reading the code you changed, and by hand in the browser.

### Collision events are opt-in

Colliders are built with `ActiveEvents::empty()`. **Nothing fires** — not
`onCollisionStart`, not `onSensorEnter`, not contact forces — until a `SetColliderEvents`
command (CommandType 48) arrives for that entity.

A collider that appears to do nothing is far more often un-opted-in than mis-simulated.

`EntityHandle.collider({ sensor: true })` opts in on its own: a sensor with no events
reports nothing, which is never what anyone wants, so it defaults to collision events
unless `events` is passed explicitly.

### Character controller `up` follows gravity

The controller's up axis is derived as `-normalize(gravity)`, falling back to **+Y** when
gravity is zero (top-down scenes).

The documented default gravity is **(0, +980)** — in pixel coordinates **+Y is DOWN**. So
the derived up is (0, −1), which is correct for a screen-space scene.

⚠️ A scene built **Y-up** inverts this: gravity then points the same way as the intended
up, every floor normal reads as a ceiling, and `isGrounded()` is permanently false while
`isSlidingDownSlope()` is permanently true. That exact bug is audit 2026-07 P1-11.

Y-up scenes must override the axis per entity with `SetCharacterUp` (CommandType 52).

### WebGPU is not testable headless

`requestAdapter()` returns null outside a real browser, so nothing automated exercises the
render path — including the physics debug wireframes.

```bash
cd ts && npm run dev
```

Enable the physics debug overlay with **F3** (`physicsDebugPlugin`). It needs a build with
the `physics-debug` feature:

```bash
cd ts && npm run build:wasm:physics:dev
```

## Before a merge

```bash
scripts/preflight.sh --full
```

Adds the release WASM builds and size gates, including the physics build — about a minute
more. Not needed on every commit.
