---
name: build-wasm
description: Rebuild Rust to WASM and start dev server
---

Execute the WASM rebuild pipeline:

1. `cargo test -p hyperion-core` — verify Rust tests pass first
2. `cd ts && npm run build:wasm` — compile Rust to WASM
3. Verify `ts/wasm/hyperion_core.d.ts` exists and check for type changes
4. `cd ts && npx tsc --noEmit` — ensure TypeScript still compiles with new WASM types
5. Ask user if they want to start the dev server (`npm run dev`)
