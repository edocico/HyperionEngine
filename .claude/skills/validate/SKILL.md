---
name: validate
description: Run the full Rust + TypeScript validation pipeline before committing
---

Run the complete validation pipeline. Execute these commands sequentially, stopping on first failure:

1. `cargo test -p hyperion-core`
2. `cargo clippy -p hyperion-core`
3. `cd ts && npm test`
4. `cd ts && npx tsc --noEmit`

Report pass/fail for each step. If all pass, confirm ready to commit.
