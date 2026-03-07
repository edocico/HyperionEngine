---
name: check-size
description: Audit WASM binary sizes for both standard and physics builds
---

Audit WASM binary sizes for both standard and physics builds. Execute sequentially:

1. Build standard WASM (release):
   ```bash
   cd ts && npm run build:wasm:release
   ```

2. Check standard size against CI gate (<200KB gzipped):
   ```bash
   cd ts && npm run check:wasm-size
   ```

3. Build physics WASM (release):
   ```bash
   cd ts && npm run build:wasm:physics:release
   ```

4. Measure physics build gzipped size:
   ```bash
   node -e "const fs=require('fs');const z=require('zlib').gzipSync(fs.readFileSync('wasm-physics/hyperion_core_bg.wasm')).length;console.log('Physics gzipped:',z,'bytes','('+Math.round(z/1024)+'KB)')"
   ```

5. Report both sizes and the delta from adding physics. Reference baselines:
   - Standard: ~48KB gzipped
   - Physics: ~267KB gzipped (+219KB from Rapier2D)

If standard build exceeds 200KB gzipped, flag as FAIL.
