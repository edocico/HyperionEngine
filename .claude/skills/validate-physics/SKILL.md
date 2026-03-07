---
name: validate-physics
description: Run the full validation pipeline including physics-2d feature flag
---

Run the complete validation pipeline with physics enabled. Execute these commands sequentially, stopping on first failure:

1. `cargo test -p hyperion-core --features physics-2d`
2. `cargo clippy -p hyperion-core --features physics-2d`
3. `cd ts && npm test`
4. `cd ts && npx tsc --noEmit`

Report pass/fail for each step. If all pass, confirm ready to commit.

Optionally, if the user requests it, also run the physics WASM build:
5. `cd ts && npm run build:wasm:physics`
